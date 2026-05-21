// Native C++ microbenchmark for ProtobufCodec encode/decode.
//
// Measures the raw codec (no JSI / JS runtime) at -O2 on the host CPU. For each
// payload profile (mirrors bench/payloads.mjs) it reports, per direction:
//   - ns/op  : median over N trials of a batch's mean ns/op (throughput metric)
//   - p50/p95/p99/min : from a sample of individually-timed ops
//   - ops/sec
//   - allocs/op : heap allocations during a single op (global new counter)
// plus the encoded byte size. Emits one JSON object to stdout.
#include "ProtobufCodec.hpp"
#include "ProtobufRegistry.hpp"
#include "AnyMap.hpp"
#include "ArrayBuffer.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

using namespace margelo::nitro;
using namespace margelo::nitro::nitroprotobuf;

// ---- allocation counter (counts every global heap allocation) -------------
static std::atomic<uint64_t> g_allocs{0};
void* operator new(std::size_t n) { g_allocs.fetch_add(1, std::memory_order_relaxed); return std::malloc(n ? n : 1); }
void* operator new[](std::size_t n) { g_allocs.fetch_add(1, std::memory_order_relaxed); return std::malloc(n ? n : 1); }
void operator delete(void* p) noexcept { std::free(p); }
void operator delete[](void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t) noexcept { std::free(p); }

// ---- timing ----------------------------------------------------------------
using clk = std::chrono::steady_clock;
static inline double ns(clk::duration d) {
  return std::chrono::duration_cast<std::chrono::duration<double, std::nano>>(d).count();
}

static volatile uint64_t g_sink = 0;

// ---- profile builders (mirror bench/payloads.mjs) --------------------------
// AnyMap setters use unordered_map::emplace (no overwrite) -> set each key once.
static std::string rep(size_t n, char c) { return std::string(n, c); }
static AnyArray bytesRange(int n) { AnyArray a; for (int i = 0; i < n; i++) a.emplace_back(AnyValue((double)i)); return a; }

static std::shared_ptr<AnyMap> build(const std::string& profile) {
  auto m = AnyMap::make();
  if (profile == "tiny") {
    m->setDouble("id", 7);
  } else if (profile == "scalars") {
    m->setDouble("id", 7);
    m->setBoolean("active", true);
    m->setString("delta", "9007199254740993");
    m->setString("big", "9007199254740993");
    m->setDouble("ratio", 0.25);
    m->setDouble("weight", 82.125);
  } else if (profile == "string") {
    m->setDouble("id", 7);
    m->setString("name", rep(32, 'x'));
    m->setArray("tags", AnyArray{AnyValue(rep(16,'a')), AnyValue(rep(16,'b')), AnyValue(rep(16,'c')), AnyValue(rep(16,'d'))});
  } else if (profile == "bytes") {
    m->setDouble("id", 7);
    m->setArray("avatar", bytesRange(32));
  } else if (profile == "repeated") {
    m->setDouble("id", 7);
    m->setArray("scores", AnyArray{AnyValue(10.0),AnyValue(20.0),AnyValue(30.0),AnyValue(40.0),AnyValue(50.0),AnyValue(60.0),AnyValue(70.0),AnyValue(80.0)});
    m->setArray("tags", AnyArray{AnyValue(std::string("a")),AnyValue(std::string("b")),AnyValue(std::string("c")),AnyValue(std::string("d"))});
  } else if (profile == "nested") {
    m->setDouble("id", 7);
    m->setObject("address", AnyObject{{"street", AnyValue(std::string("Main St"))}, {"zip", AnyValue(12345.0)}});
  } else if (profile == "default") {
    m->setDouble("id", 7);
    m->setString("name", "Ada");
    m->setBoolean("active", true);
    m->setString("delta", "9007199254740993");
    m->setString("big", "9007199254740993");
    m->setDouble("ratio", 0.25);
    m->setDouble("weight", 82.125);
    m->setArray("scores", AnyArray{AnyValue(10.0), AnyValue(20.0)});
    m->setArray("tags", AnyArray{AnyValue(std::string("a")), AnyValue(std::string("b"))});
    m->setArray("avatar", AnyArray{AnyValue(1.0), AnyValue(2.0), AnyValue(3.0)});
    m->setObject("address", AnyObject{{"street", AnyValue(std::string("Main St"))}, {"zip", AnyValue(12345.0)}});
  } else if (profile == "large") {
    m->setDouble("id", 4294967295.0);
    m->setString("name", rep(32, 'x'));
    m->setBoolean("active", true);
    m->setString("delta", "9223372036854775807");
    m->setString("big", "18446744073709551615");
    m->setDouble("ratio", 3.4028235e38);
    m->setDouble("weight", 1.7976931348623157e308);
    m->setArray("scores", AnyArray{AnyValue(1.0),AnyValue(2.0),AnyValue(3.0),AnyValue(4.0),AnyValue(5.0),AnyValue(6.0),AnyValue(7.0),AnyValue(8.0)});
    m->setArray("tags", AnyArray{AnyValue(rep(16,'a')), AnyValue(rep(16,'b')), AnyValue(rep(16,'c')), AnyValue(rep(16,'d'))});
    m->setArray("avatar", bytesRange(32));
    m->setObject("address", AnyObject{{"street", AnyValue(rep(64,'s'))}, {"zip", AnyValue(4294967295.0)}});
  }
  return m;
}

struct Stat { double nsop, p50, p95, p99, minv, opsps; uint64_t allocs; };

template <class Op>
static Stat measure(Op op) {
  const int WARMUP = 20000;
  const int TRIALS = 7;
  const size_t BATCH = 200000; // mean ns/op per trial
  const size_t SAMPLES = 50000; // individual timings for percentiles

  for (int i = 0; i < WARMUP; i++) op();

  // throughput: median of per-trial mean ns/op
  std::vector<double> trialNsop;
  for (int t = 0; t < TRIALS; t++) {
    auto t0 = clk::now();
    for (size_t i = 0; i < BATCH; i++) op();
    auto t1 = clk::now();
    trialNsop.push_back(ns(t1 - t0) / double(BATCH));
  }
  std::sort(trialNsop.begin(), trialNsop.end());
  double nsop = trialNsop[trialNsop.size() / 2];

  // percentile distribution from individually-timed ops
  std::vector<double> s;
  s.reserve(SAMPLES);
  for (size_t i = 0; i < SAMPLES; i++) {
    auto t0 = clk::now();
    op();
    auto t1 = clk::now();
    s.push_back(ns(t1 - t0));
  }
  std::sort(s.begin(), s.end());
  auto pct = [&](double p) { return s[(size_t)(p * (s.size() - 1))]; };

  // allocations for a single op (counter delta)
  uint64_t a0 = g_allocs.load(std::memory_order_relaxed);
  op();
  uint64_t allocs = g_allocs.load(std::memory_order_relaxed) - a0;

  return Stat{nsop, pct(0.50), pct(0.95), pct(0.99), s.front(), 1e9 / nsop, allocs};
}

int main() {
  const MessageInfo* user = getMessageInfo("acme.User");
  if (!user) { std::fprintf(stderr, "acme.User not registered\n"); return 2; }

  const char* profiles[] = {"tiny","scalars","string","bytes","repeated","nested","default","large"};

  std::printf("[\n");
  bool first = true;
  for (const char* name : profiles) {
    auto m = build(name);
    auto buf = encodeMessage(*user, m); // also gives byte size
    size_t bytes = buf->size();

    Stat enc = measure([&] { auto b = encodeMessage(*user, m); g_sink ^= b->size(); });
    Stat dec = measure([&] { auto d = decodeMessage(*user, buf); g_sink ^= reinterpret_cast<uintptr_t>(d.get()); });

    if (!first) std::printf(",\n");
    first = false;
    std::printf(
      "  {\"profile\":\"%s\",\"bytes\":%zu,"
      "\"encode\":{\"nsop\":%.1f,\"opsps\":%.0f,\"p50\":%.1f,\"p95\":%.1f,\"p99\":%.1f,\"min\":%.1f,\"allocs\":%llu},"
      "\"decode\":{\"nsop\":%.1f,\"opsps\":%.0f,\"p50\":%.1f,\"p95\":%.1f,\"p99\":%.1f,\"min\":%.1f,\"allocs\":%llu}}",
      name, bytes,
      enc.nsop, enc.opsps, enc.p50, enc.p95, enc.p99, enc.minv, (unsigned long long)enc.allocs,
      dec.nsop, dec.opsps, dec.p50, dec.p95, dec.p99, dec.minv, (unsigned long long)dec.allocs);
  }
  std::printf("\n]\n");
  (void)g_sink;
  return 0;
}
