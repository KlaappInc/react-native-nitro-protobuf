// Exhaustive ASan/UBSan harness for ProtobufCodec encode/decode.
// Targets ANALYSIS hotspots: C1 (string strlen OOB), C2 (stoX throw),
// C6 (bytes offsetof underflow), and decode of adversarial/garbage bytes.
#include "ProtobufCodec.hpp"
#include "ProtobufRegistry.hpp"
#include "AnyMap.hpp"
#include "ArrayBuffer.hpp"
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <functional>
#include <random>
#include <string>
#include <vector>

using namespace margelo::nitro;
using namespace margelo::nitro::nitroprotobuf;

static int g_fail = 0;
static int g_ok = 0;

static void ok(bool cond, const char* what) {
  if (cond) { g_ok++; }
  else { g_fail++; std::fprintf(stderr, "FAIL: %s\n", what); }
}

// Expect fn() to throw std::exception (graceful), NOT crash/UB.
static void expectThrow(const char* label, const std::function<void()>& fn) {
  try {
    fn();
    g_fail++;
    std::fprintf(stderr, "FAIL: %s did NOT throw (expected graceful error)\n", label);
  } catch (const std::exception&) {
    g_ok++;
  } catch (...) {
    g_fail++;
    std::fprintf(stderr, "FAIL: %s threw NON-std exception\n", label);
  }
}

// Expect fn() to either succeed or throw std::exception - never crash/UB.
// (ASan/UBSan will abort the process if it touches bad memory.)
static void expectNoCrash(const char* label, const std::function<void()>& fn) {
  try { fn(); g_ok++; }
  catch (const std::exception&) { g_ok++; }
  catch (...) { g_fail++; std::fprintf(stderr, "FAIL: %s threw NON-std exception\n", label); }
}

// NOTE: AnyMap setters use unordered_map::emplace, which does NOT overwrite an
// existing key. So every test below sets each key AT MOST ONCE (baseUser only
// seeds "id"); the field under test is set exactly once by the test itself.
static std::shared_ptr<AnyMap> baseUser() {
  auto m = AnyMap::make();
  m->setDouble("id", 7);
  return m;
}

int main() {
  const MessageInfo* user = getMessageInfo("acme.User");
  const MessageInfo* addr = getMessageInfo("acme.Address");
  ok(user != nullptr, "acme.User registered");
  ok(addr != nullptr, "acme.Address registered");
  if (!user) return 2;

  // ---------- 1. Full round-trip, every field type ----------
  {
    auto m = baseUser();
    m->setString("name", "Ada");
    m->setBoolean("active", true);
    m->setString("delta", "9007199254740993");   // int64 as string
    m->setString("big", "9007199254740993");      // uint64 as string
    m->setDouble("ratio", 0.25);
    m->setDouble("weight", 82.125);
    AnyArray scores; scores.emplace_back(AnyValue(10.0)); scores.emplace_back(AnyValue(20.0));
    m->setArray("scores", scores);
    AnyArray tags; tags.emplace_back(AnyValue(std::string("a"))); tags.emplace_back(AnyValue(std::string("b")));
    m->setArray("tags", tags);
    AnyArray avatar; for (int i=0;i<3;i++) avatar.emplace_back(AnyValue((double)i));
    m->setArray("avatar", avatar);
    AnyObject a; a["street"]=AnyValue(std::string("Main St")); a["zip"]=AnyValue(12345.0);
    m->setObject("address", a);

    auto buf = encodeMessage(*user, m);
    ok(buf && buf->size() > 0, "full encode produced bytes");
    auto dec = decodeMessage(*user, buf);
    ok(dec->getDouble("id")==7, "rt id");
    ok(dec->getString("name")=="Ada", "rt name");
    ok(dec->getBoolean("active")==true, "rt active");
    ok(dec->getString("delta")=="9007199254740993", "rt int64");
    ok(dec->getString("big")=="9007199254740993", "rt uint64");
    ok(dec->getString("avatar")=="AAEC", "rt bytes base64");
    ok(dec->getArray("scores").size()==2, "rt scores");
    ok(dec->getArray("tags").size()==2, "rt tags");
    auto oa = dec->getObject("address");
    ok(std::get<std::string>(oa.at("street"))=="Main St", "rt addr.street");
  }

  // ---------- 2. Integer boundary values (fresh map each - avoid emplace no-overwrite) ----------
  {
    auto m1 = baseUser(); m1->setString("delta", "9223372036854775807");   // INT64_MAX
    ok(decodeMessage(*user, encodeMessage(*user, m1))->getString("delta")=="9223372036854775807", "int64 max");
    auto m2 = baseUser(); m2->setString("delta", "-9223372036854775808");  // INT64_MIN
    ok(decodeMessage(*user, encodeMessage(*user, m2))->getString("delta")=="-9223372036854775808", "int64 min");
    auto m3 = baseUser(); m3->setString("big", "18446744073709551615");    // UINT64_MAX
    ok(decodeMessage(*user, encodeMessage(*user, m3))->getString("big")=="18446744073709551615", "uint64 max");
  }

  // ---------- 3. C2: non-numeric / out-of-range strings for numerics ----------
  expectThrow("id non-numeric", [&]{ auto m=baseUser(); m->setString("delta","not-a-number"); encodeMessage(*user,m); });
  expectThrow("delta empty string", [&]{ auto m=baseUser(); m->setString("delta",""); encodeMessage(*user,m); });
  expectThrow("big overflow string", [&]{ auto m=baseUser(); m->setString("big","999999999999999999999999"); encodeMessage(*user,m); });
  // After C2 fix: trailing garbage is rejected (full-consume parse).
  expectThrow("ratio '1.2.3.4' rejected", [&]{ auto m=baseUser(); m->setString("ratio","1.2.3.4"); encodeMessage(*user,m); });
  expectThrow("delta '12abc' rejected", [&]{ auto m=baseUser(); m->setString("delta","12abc"); encodeMessage(*user,m); });
  expectThrow("big negative string rejected", [&]{ auto m=baseUser(); m->setString("big","-5"); encodeMessage(*user,m); });

  // ---------- 4. String length boundaries (name char[33] => 32 usable chars) ----------
  expectNoCrash("name len 0", [&]{ auto m=baseUser(); m->setString("name",""); auto b=encodeMessage(*user,m); decodeMessage(*user,b); });
  expectNoCrash("name len 31", [&]{ auto m=baseUser(); m->setString("name",std::string(31,'x')); auto b=encodeMessage(*user,m); ok(decodeMessage(*user,b)->getString("name").size()==31,"name31 rt"); });
  expectNoCrash("name len 32 (fits char[33])", [&]{ auto m=baseUser(); m->setString("name",std::string(32,'x')); auto b=encodeMessage(*user,m); ok(decodeMessage(*user,b)->getString("name").size()==32,"name32 rt"); });
  expectThrow("name len 33 (>= cap)", [&]{ auto m=baseUser(); m->setString("name",std::string(33,'x')); encodeMessage(*user,m); });
  expectThrow("name len 100", [&]{ auto m=baseUser(); m->setString("name",std::string(100,'x')); encodeMessage(*user,m); });

  // ---------- 5. Bytes boundaries (avatar max_size:32) + C6 ----------
  expectNoCrash("avatar empty array", [&]{ auto m=baseUser(); m->setArray("avatar", AnyArray{}); auto b=encodeMessage(*user,m); decodeMessage(*user,b); });
  expectNoCrash("avatar 32 bytes", [&]{ auto m=baseUser(); AnyArray v; for(int i=0;i<32;i++) v.emplace_back(AnyValue(1.0)); m->setArray("avatar",v); auto b=encodeMessage(*user,m); decodeMessage(*user,b); });
  expectThrow("avatar 33 bytes", [&]{ auto m=baseUser(); AnyArray v; for(int i=0;i<33;i++) v.emplace_back(AnyValue(1.0)); m->setArray("avatar",v); encodeMessage(*user,m); });
  expectNoCrash("avatar base64 empty", [&]{ auto m=baseUser(); m->setString("avatar",""); auto b=encodeMessage(*user,m); decodeMessage(*user,b); });
  expectNoCrash("avatar base64 valid", [&]{ auto m=baseUser(); m->setString("avatar","AAEC"); auto b=encodeMessage(*user,m); decodeMessage(*user,b); });
  expectThrow("avatar bad base64", [&]{ auto m=baseUser(); m->setString("avatar","###notb64"); encodeMessage(*user,m); });
  expectThrow("avatar byte 256 out of range", [&]{ auto m=baseUser(); AnyArray v; v.emplace_back(AnyValue(256.0)); m->setArray("avatar",v); encodeMessage(*user,m); });
  expectThrow("avatar byte -1 out of range", [&]{ auto m=baseUser(); AnyArray v; v.emplace_back(AnyValue(-1.0)); m->setArray("avatar",v); encodeMessage(*user,m); });

  // ---------- 6. Repeated count boundaries (scores max_count:8, tags 4) ----------
  expectNoCrash("scores 8", [&]{ auto m=baseUser(); AnyArray v; for(int i=0;i<8;i++) v.emplace_back(AnyValue((double)i)); m->setArray("scores",v); auto b=encodeMessage(*user,m); ok(decodeMessage(*user,b)->getArray("scores").size()==8,"scores8 rt"); });
  expectThrow("scores 9", [&]{ auto m=baseUser(); AnyArray v; for(int i=0;i<9;i++) v.emplace_back(AnyValue((double)i)); m->setArray("scores",v); encodeMessage(*user,m); });
  expectThrow("tags 5", [&]{ auto m=baseUser(); AnyArray v; for(int i=0;i<5;i++) v.emplace_back(AnyValue(std::string("t"))); m->setArray("tags",v); encodeMessage(*user,m); });
  expectThrow("tag len 17 (>max_length 16)", [&]{ auto m=baseUser(); AnyArray v; v.emplace_back(AnyValue(std::string(17,'t'))); m->setArray("tags",v); encodeMessage(*user,m); });

  // ---------- 7. Type mismatches ----------
  expectThrow("name as number", [&]{ auto m=baseUser(); m->setDouble("name",123); encodeMessage(*user,m); });
  expectThrow("active as string", [&]{ auto m=baseUser(); m->setString("active","yes"); encodeMessage(*user,m); });
  expectThrow("scores as scalar", [&]{ auto m=baseUser(); m->setDouble("scores",5); encodeMessage(*user,m); });
  expectThrow("address as string", [&]{ auto m=baseUser(); m->setString("address","oops"); encodeMessage(*user,m); });
  expectThrow("unknown field", [&]{ auto m=baseUser(); m->setDouble("nope",1); encodeMessage(*user,m); });

  // ---------- 8. Nested message edge ----------
  expectNoCrash("address empty obj", [&]{ auto m=baseUser(); m->setObject("address", AnyObject{}); auto b=encodeMessage(*user,m); decodeMessage(*user,b); });
  expectThrow("address.zip wrong type", [&]{ auto m=baseUser(); AnyObject a; a["zip"]=AnyValue(std::string("x")); m->setObject("address",a); encodeMessage(*user,m); });
  expectThrow("address unknown nested field", [&]{ auto m=baseUser(); AnyObject a; a["ghost"]=AnyValue(1.0); m->setObject("address",a); encodeMessage(*user,m); });

  // ---------- 9. NULL values are skipped ----------
  expectNoCrash("null name skipped", [&]{ auto m=baseUser(); m->setNull("name"); auto b=encodeMessage(*user,m); decodeMessage(*user,b); });

  // ---------- 10. DECODE FUZZ - the crash-suspect path ----------
  // 10a. truncated valid buffer at every prefix length
  {
    auto m = baseUser();
    m->setString("name", std::string(31,'Z'));
    AnyArray v; for(int i=0;i<8;i++) v.emplace_back(AnyValue((double)i)); m->setArray("scores",v);
    AnyArray av; for(int i=0;i<32;i++) av.emplace_back(AnyValue((double)i)); m->setArray("avatar",av);
    auto buf = encodeMessage(*user, m);
    std::vector<uint8_t> full(buf->data(), buf->data()+buf->size());
    for (size_t len=0; len<=full.size(); ++len) {
      auto ab = ArrayBuffer::copy(full.data(), len);
      char lbl[64]; std::snprintf(lbl,sizeof lbl,"decode truncated len=%zu",len);
      if (len==0) expectThrow(lbl, [&]{ decodeMessage(*user, ab); });
      else        expectNoCrash(lbl, [&]{ decodeMessage(*user, ab); });
    }
  }

  // 10b. random garbage bytes, many seeds + lengths
  {
    std::mt19937 rng(0xC0FFEE);
    std::uniform_int_distribution<int> byte(0,255);
    for (int iter=0; iter<20000; ++iter) {
      size_t len = rng()%128;
      std::vector<uint8_t> g(len);
      for (auto& b: g) b = (uint8_t)byte(rng);
      // Empty vector data() is nullptr on libstdc++; ArrayBuffer::copy would then
      // memcpy(dst, nullptr, 0) (benign, but UBSan flags the NON_NULL violation).
      // Reserve so data() is non-null while size stays 0.
      if (g.empty()) g.reserve(1);
      auto ab = ArrayBuffer::copy(g.data(), g.size());
      expectNoCrash("decode random garbage", [&]{ decodeMessage(*user, ab); });
      expectNoCrash("decode random garbage (Address)", [&]{ if(addr) decodeMessage(*addr, ab); });
    }
  }

  // 10c. crafted: oversize length-delimited string on the wire (field 2 = name, wire type 2)
  {
    // tag for field 2, wiretype 2 (LEN) = (2<<3)|2 = 0x12, then huge varint length
    for (uint64_t declared : {50ull, 1000ull, 100000ull, 0xFFFFFFFFull}) {
      std::vector<uint8_t> w; w.push_back(0x12);
      uint64_t x=declared; do { uint8_t b=x&0x7F; x>>=7; if(x) b|=0x80; w.push_back(b);} while(x);
      w.push_back('A'); w.push_back('B'); // only 2 actual bytes, far less than declared
      auto ab = ArrayBuffer::copy(w.data(), w.size());
      expectNoCrash("decode oversize-LEN string", [&]{ decodeMessage(*user, ab); });
    }
  }

  // 10d. crafted: every single-byte buffer (all field tags / wiretypes)
  for (int b=0; b<256; ++b) {
    uint8_t one=(uint8_t)b; auto ab=ArrayBuffer::copy(&one,1);
    expectNoCrash("decode single byte", [&]{ decodeMessage(*user, ab); });
  }

  // 10e. crafted: bit-flips of a valid buffer
  {
    auto buf = encodeMessage(*user, baseUser());
    std::vector<uint8_t> full(buf->data(), buf->data()+buf->size());
    for (size_t i=0;i<full.size();++i) for (int bit=0;bit<8;++bit) {
      auto f=full; f[i]^=(1<<bit);
      auto ab=ArrayBuffer::copy(f.data(),f.size());
      expectNoCrash("decode bitflip", [&]{ decodeMessage(*user, ab); });
    }
  }

  // ---------- 11. oneof: round-trip each member + adversarial decode ----------
  const MessageInfo* pick = getMessageInfo("acme.Pick");
  ok(pick != nullptr, "acme.Pick registered");
  if (pick) {
    // string member
    expectNoCrash("oneof string rt", [&]{
      auto m = AnyMap::make(); m->setDouble("id", 1); m->setString("name", "Bob");
      auto d = decodeMessage(*pick, encodeMessage(*pick, m));
      ok(d->getString("name") == "Bob", "oneof name present");
      ok(d->getMap().count("age") == 0 && d->getMap().count("inner") == 0, "oneof others absent");
    });
    // int member (switches the union)
    expectNoCrash("oneof int rt", [&]{
      auto m = AnyMap::make(); m->setDouble("age", 7);
      auto d = decodeMessage(*pick, encodeMessage(*pick, m));
      ok(d->getDouble("age") == 7, "oneof age present");
      ok(d->getMap().count("name") == 0, "oneof name absent when age set");
    });
    // message member
    expectNoCrash("oneof msg rt", [&]{
      auto m = AnyMap::make(); AnyObject in; in["label"] = AnyValue(std::string("L"));
      m->setObject("inner", in);
      auto d = decodeMessage(*pick, encodeMessage(*pick, m));
      ok(d->getMap().count("inner") == 1, "oneof inner present");
    });
    // no member set -> nothing present (which_ == 0)
    expectNoCrash("oneof none", [&]{
      auto m = AnyMap::make(); m->setDouble("id", 9);
      auto d = decodeMessage(*pick, encodeMessage(*pick, m));
      ok(d->getMap().count("name") == 0 && d->getMap().count("age") == 0 && d->getMap().count("inner") == 0, "oneof empty");
    });

    // Adversarial: random garbage decoded as Pick must never crash (exercises
    // the which_ selector + union member decode on hostile input).
    {
      std::mt19937 rng(0xBADF00D);
      std::uniform_int_distribution<int> byte(0,255);
      for (int iter=0; iter<20000; ++iter) {
        size_t len = rng()%96;
        std::vector<uint8_t> g(len);
        for (auto& b: g) b = (uint8_t)byte(rng);
        if (g.empty()) g.reserve(1);
        auto ab = ArrayBuffer::copy(g.data(), g.size());
        expectNoCrash("decode random garbage (Pick)", [&]{ decodeMessage(*pick, ab); });
      }
    }
    // Bit-flips of a valid oneof buffer (message member = largest union slot).
    {
      auto m = AnyMap::make(); AnyObject in; in["label"] = AnyValue(std::string("hello"));
      m->setObject("inner", in);
      auto buf = encodeMessage(*pick, m);
      std::vector<uint8_t> full(buf->data(), buf->data()+buf->size());
      for (size_t i=0;i<full.size();++i) for (int bit=0;bit<8;++bit) {
        auto f=full; f[i]^=(1<<bit);
        auto ab=ArrayBuffer::copy(f.data(),f.size());
        expectNoCrash("decode oneof bitflip", [&]{ decodeMessage(*pick, ab); });
      }
    }
  }

  // ---------- 12. map<K,V>: round-trip + adversarial decode ----------
  const MessageInfo* withMap = getMessageInfo("acme.WithMap");
  ok(withMap != nullptr, "acme.WithMap registered");
  if (withMap) {
    // listMessages must hide the synthetic entry types.
    auto names = getMessageNames();
    bool hasEntry = false;
    for (const auto& n : names) if (n.find("Entry") != std::string::npos) hasEntry = true;
    ok(!hasEntry, "listMessages hides map entry types");

    expectNoCrash("map<string,int32> rt", [&]{
      auto m = AnyMap::make(); m->setDouble("id", 1);
      AnyObject counts; counts["a"] = AnyValue(1.0); counts["b"] = AnyValue(2.0);
      m->setObject("counts", counts);
      auto d = decodeMessage(*withMap, encodeMessage(*withMap, m));
      auto out = d->getObject("counts");
      ok(out.size() == 2 && std::get<double>(out.at("a")) == 1.0, "map scalar values");
    });
    expectNoCrash("map<string,Inner> rt", [&]{
      auto m = AnyMap::make();
      AnyObject objs; objs["x"] = AnyValue(AnyObject{{"label", AnyValue(std::string("hi"))}});
      m->setObject("objs", objs);
      auto d = decodeMessage(*withMap, encodeMessage(*withMap, m));
      auto out = d->getObject("objs");
      ok(out.size() == 1, "map message value count");
    });
    expectNoCrash("map empty", [&]{
      auto m = AnyMap::make(); m->setDouble("id", 3);
      decodeMessage(*withMap, encodeMessage(*withMap, m));
    });
    // Adversarial garbage decoded as WithMap (entry key/value decode on hostile input).
    {
      std::mt19937 rng(0x5A1AD00D);
      std::uniform_int_distribution<int> byte(0,255);
      for (int iter=0; iter<20000; ++iter) {
        size_t len = rng()%96;
        std::vector<uint8_t> g(len);
        for (auto& b: g) b = (uint8_t)byte(rng);
        if (g.empty()) g.reserve(1);
        auto ab = ArrayBuffer::copy(g.data(), g.size());
        expectNoCrash("decode random garbage (WithMap)", [&]{ decodeMessage(*withMap, ab); });
      }
    }
    // Bit-flips of a valid map buffer.
    {
      auto m = AnyMap::make();
      AnyObject counts; counts["kk"] = AnyValue(7.0);
      m->setObject("counts", counts);
      AnyObject objs; objs["o"] = AnyValue(AnyObject{{"label", AnyValue(std::string("z"))}});
      m->setObject("objs", objs);
      auto buf = encodeMessage(*withMap, m);
      std::vector<uint8_t> full(buf->data(), buf->data()+buf->size());
      for (size_t i=0;i<full.size();++i) for (int bit=0;bit<8;++bit) {
        auto f=full; f[i]^=(1<<bit);
        auto ab=ArrayBuffer::copy(f.data(),f.size());
        expectNoCrash("decode map bitflip", [&]{ decodeMessage(*withMap, ab); });
      }
    }
  }

  std::printf("\n==== HARNESS DONE ====\nPASS checks: %d\nFAIL checks: %d\n", g_ok, g_fail);
  return g_fail==0 ? 0 : 1;
}
