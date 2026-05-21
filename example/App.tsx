import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context';
import { NitroProtobuf } from '@klaappinc/react-native-nitro-protobuf';
import { runBench, formatResults } from './src/bench';

const MESSAGE_NAME = 'acme.User';

const SAMPLE_PAYLOAD = {
  id: 7,
  name: 'Ada',
  active: true,
  delta: '9007199254740993',
  big: '9007199254740993',
  ratio: 0.25,
  weight: 82.125,
  scores: [10, 20],
  tags: ['a', 'b'],
  avatar: [1, 2, 3],
  address: {
    street: 'Main St',
    zip: 12345,
  },
};

type ResultState = {
  encodedLength?: number;
  encodedHex?: string;
  encodedDecimal?: string;
  encodedBase64?: string;
  encodedBinary?: string;
  jsonBytes?: number;
  sizeDeltaBytes?: number;
  sizeDeltaPercent?: number;
  sizeRatio?: number;
  encodeMs?: number;
  decodeMs?: number;
  decoded?: unknown;
  messages?: string[];
  error?: string;
};

const BASE64_TABLE =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SAMPLE_PAYLOAD_TEXT = JSON.stringify(SAMPLE_PAYLOAD, null, 2);

const nowMs = () =>
  typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();

const utf8ByteLength = (text: string) => {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).length;
  }
  return text.length;
};

const bytesToHex = (bytes: Uint8Array) => {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  const lines: string[] = [];
  for (let i = 0; i < hex.length; i += 16) {
    lines.push(hex.slice(i, i + 16).join(' '));
  }
  return lines.join('\n');
};

const bytesToDecimal = (bytes: Uint8Array) => {
  const dec = Array.from(bytes, (byte) => byte.toString(10));
  const lines: string[] = [];
  for (let i = 0; i < dec.length; i += 16) {
    lines.push(dec.slice(i, i + 16).join(' '));
  }
  return lines.join('\n');
};

const bytesToBinary = (bytes: Uint8Array) => {
  const bin = Array.from(bytes, (byte) => byte.toString(2).padStart(8, '0'));
  const lines: string[] = [];
  for (let i = 0; i < bin.length; i += 8) {
    lines.push(bin.slice(i, i + 8).join(' '));
  }
  return lines.join('\n');
};

const bytesToBase64 = (bytes: Uint8Array) => {
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    output += BASE64_TABLE[(triplet >> 18) & 0x3f];
    output += BASE64_TABLE[(triplet >> 12) & 0x3f];
    output += i + 1 < bytes.length ? BASE64_TABLE[(triplet >> 6) & 0x3f] : '=';
    output += i + 2 < bytes.length ? BASE64_TABLE[triplet & 0x3f] : '=';
  }
  return output;
};

const fadeUp = (anim: Animated.Value) => ({
  opacity: anim,
  transform: [
    {
      translateY: anim.interpolate({
        inputRange: [0, 1],
        outputRange: [12, 0],
      }),
    },
  ],
});

function App() {
  const [result, setResult] = useState<ResultState>({});
  const [messageName, setMessageName] = useState(MESSAGE_NAME);
  const [payloadText, setPayloadText] = useState(SAMPLE_PAYLOAD_TEXT);
  const [benchStatus, setBenchStatus] = useState('');
  const headerAnim = useRef(new Animated.Value(0)).current;
  const cardAnims = useRef([
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ]).current;

  const runRoundTrip = useCallback(() => {
    try {
      if (!messageName.trim()) {
        throw new Error('Message name is required.');
      }

      let parsedPayload: unknown = null;
      try {
        parsedPayload = JSON.parse(payloadText);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Invalid JSON payload.';
        throw new Error(`Payload JSON error: ${message}`);
      }

      if (
        parsedPayload === null ||
        typeof parsedPayload !== 'object' ||
        Array.isArray(parsedPayload)
      ) {
        throw new Error('Payload must be a JSON object at the top level.');
      }

      const encodeStart = nowMs();
      const encoded = NitroProtobuf.encode(
        messageName.trim(),
        parsedPayload as Record<string, unknown>
      );
      const encodeMs = nowMs() - encodeStart;

      const decodeStart = nowMs();
      const decoded = NitroProtobuf.decode(messageName.trim(), encoded);
      const decodeMs = nowMs() - decodeStart;

      const messages = NitroProtobuf.listMessages();
      const bytes = new Uint8Array(encoded);
      const jsonMinified = JSON.stringify(parsedPayload);
      const jsonBytes = utf8ByteLength(jsonMinified);
      const sizeDeltaBytes = jsonBytes - encoded.byteLength;
      const sizeDeltaPercent = jsonBytes
        ? (sizeDeltaBytes / jsonBytes) * 100
        : undefined;
      const sizeRatio = encoded.byteLength
        ? jsonBytes / encoded.byteLength
        : undefined;
      setResult({
        encodedLength: encoded.byteLength,
        encodedHex: bytesToHex(bytes),
        encodedDecimal: bytesToDecimal(bytes),
        encodedBase64: bytesToBase64(bytes),
        encodedBinary: bytesToBinary(bytes),
        jsonBytes,
        sizeDeltaBytes,
        sizeDeltaPercent,
        sizeRatio,
        encodeMs,
        decodeMs,
        decoded,
        messages,
      });
    } catch (error) {
      setResult({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [messageName, payloadText]);

  const resetInputs = useCallback(() => {
    setMessageName(MESSAGE_NAME);
    setPayloadText(SAMPLE_PAYLOAD_TEXT);
    setResult({});
  }, []);

  const runBenchmark = useCallback(() => {
    setBenchStatus('Running benchmark… (~40s)');
    // Defer so the status text paints before the blocking bench loop runs.
    setTimeout(() => {
      try {
        const r = runBench(Platform.OS);
        setBenchStatus('BENCH_DONE\n' + formatResults(r));
      } catch (e) {
        setBenchStatus('Bench error: ' + (e instanceof Error ? e.message : String(e)));
      }
    }, 50);
  }, []);

  useEffect(() => {
    runRoundTrip();
  }, [runRoundTrip]);

  useEffect(() => {
    const isTestEnv =
      (globalThis as { __IS_JEST__?: boolean }).__IS_JEST__ === true;

    if (isTestEnv) {
      headerAnim.setValue(1);
      cardAnims.forEach((anim) => anim.setValue(1));
      return;
    }

    const animation = Animated.stagger(120, [
      Animated.timing(headerAnim, {
        toValue: 1,
        duration: 350,
        useNativeDriver: false,
      }),
      ...cardAnims.map((anim) =>
        Animated.timing(anim, {
          toValue: 1,
          duration: 350,
          useNativeDriver: false,
        })
      ),
    ]);

    animation.start();
    return () => animation.stop();
  }, [cardAnims, headerAnim]);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root}>
        <View pointerEvents="none" style={styles.background}>
          <View style={styles.orbPrimary} />
          <View style={styles.orbSecondary} />
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <Animated.View style={[styles.header, fadeUp(headerAnim)]}>
            <Text style={styles.title}>Nitro Protobuf</Text>
            <Text style={styles.subtitle}>Nanopb encode/decode round-trip</Text>
          </Animated.View>

          <Animated.View style={[fadeUp(cardAnims[0])]}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Inputs</Text>
              <Text style={styles.label}>Message name</Text>
              <TextInput
                style={styles.input}
                value={messageName}
                onChangeText={setMessageName}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                placeholder="acme.User"
                placeholderTextColor="#64748b"
              />

              <Text style={styles.label}>Payload (JSON)</Text>
              <TextInput
                style={[styles.input, styles.inputMultiline]}
                value={payloadText}
                onChangeText={setPayloadText}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                multiline
                textAlignVertical="top"
              />

              <View style={styles.buttonRow}>
                <Pressable
                  style={[styles.button, styles.buttonSecondary]}
                  onPress={resetInputs}
                >
                  <Text style={[styles.buttonText, styles.buttonTextSecondary]}>
                    Reset sample
                  </Text>
                </Pressable>
                <Pressable style={styles.button} onPress={runRoundTrip}>
                  <Text style={styles.buttonText}>Run round-trip</Text>
                </Pressable>
              </View>
              <Pressable
                style={[styles.button, styles.buttonSecondary]}
                onPress={runBenchmark}
              >
                <Text style={[styles.buttonText, styles.buttonTextSecondary]}>
                  Run benchmark
                </Text>
              </Pressable>
              {benchStatus ? (
                <Text style={styles.meta}>{benchStatus}</Text>
              ) : null}
            </View>
          </Animated.View>

          <Animated.View style={[fadeUp(cardAnims[1])]}>
            {result.error ? (
              <View style={[styles.card, styles.errorCard]}>
                <Text style={styles.cardTitle}>Error</Text>
                <Text style={styles.errorText}>{result.error}</Text>
              </View>
            ) : (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Result</Text>
                <Text style={styles.meta}>
                  Encoded bytes: {result.encodedLength ?? '-'}
                </Text>
                <Text style={styles.meta}>
                  JSON (minified): {result.jsonBytes ?? '-'} bytes
                </Text>
                <Text style={styles.meta}>
                  {result.sizeDeltaBytes != null
                    ? result.sizeDeltaBytes >= 0
                      ? `Savings: +${result.sizeDeltaBytes} bytes (${result.sizeDeltaPercent?.toFixed(1) ?? '-'}%)`
                      : `Overhead: ${Math.abs(result.sizeDeltaBytes)} bytes (${Math.abs(result.sizeDeltaPercent ?? 0).toFixed(1)}%)`
                    : 'Savings: -'}
                </Text>
                <Text style={styles.meta}>
                  JSON/Protobuf ratio:{' '}
                  {result.sizeRatio != null && Number.isFinite(result.sizeRatio)
                    ? `${result.sizeRatio.toFixed(2)}x`
                    : '-'}
                </Text>
                <Text style={styles.meta}>
                  Encode time: {result.encodeMs?.toFixed(2) ?? '-'} ms
                </Text>
                <Text style={styles.meta}>
                  Decode time: {result.decodeMs?.toFixed(2) ?? '-'} ms
                </Text>
                <Text style={styles.meta}>
                  Messages: {(result.messages ?? []).join(', ') || '-'}
                </Text>
                <Text style={styles.label}>Encoded (hex)</Text>
                <Text style={styles.code}>{result.encodedHex ?? '-'}</Text>
                <Text style={styles.label}>Encoded (decimal)</Text>
                <Text style={styles.code}>{result.encodedDecimal ?? '-'}</Text>
                <Text style={styles.label}>Encoded (binary)</Text>
                <Text style={styles.code}>{result.encodedBinary ?? '-'}</Text>
                <Text style={styles.label}>Encoded (base64)</Text>
                <Text style={styles.code}>{result.encodedBase64 ?? '-'}</Text>
              </View>
            )}
          </Animated.View>

          <Animated.View style={[fadeUp(cardAnims[2])]}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Decoded</Text>
              <Text style={styles.code}>
                {result.decoded ? JSON.stringify(result.decoded, null, 2) : '-'}
              </Text>
            </View>
          </Animated.View>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  background: {
    ...StyleSheet.absoluteFill,
  },
  orbPrimary: {
    position: 'absolute',
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: '#38bdf8',
    opacity: 0.18,
    top: -40,
    left: -30,
  },
  orbSecondary: {
    position: 'absolute',
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: '#f97316',
    opacity: 0.15,
    bottom: -30,
    right: -10,
  },
  content: {
    padding: 20,
    gap: 16,
  },
  header: {
    gap: 10,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#f8fafc',
    fontFamily: Platform.select({
      ios: 'AvenirNext-Heavy',
      android: 'sans-serif-condensed',
    }),
  },
  subtitle: {
    fontSize: 16,
    color: '#cbd5f5',
    fontFamily: Platform.select({
      ios: 'AvenirNext-Medium',
      android: 'sans-serif-medium',
    }),
  },
  label: {
    color: '#94a3b8',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontFamily: Platform.select({
      ios: 'AvenirNext-DemiBold',
      android: 'sans-serif-medium',
    }),
  },
  code: {
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
    }),
    color: '#e2e8f0',
    fontSize: 13,
  },
  input: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#e2e8f0',
    fontSize: 14,
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
    }),
    borderWidth: 1,
    borderColor: '#334155',
  },
  inputMultiline: {
    minHeight: 160,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  button: {
    backgroundColor: '#38bdf8',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    flex: 1,
  },
  buttonSecondary: {
    backgroundColor: '#1f2937',
    borderWidth: 1,
    borderColor: '#334155',
  },
  buttonText: {
    color: '#0f172a',
    fontWeight: '600',
    fontSize: 16,
  },
  buttonTextSecondary: {
    color: '#e2e8f0',
  },
  card: {
    backgroundColor: '#1e293b',
    padding: 16,
    borderRadius: 14,
    gap: 8,
  },
  errorCard: {
    backgroundColor: '#7f1d1d',
  },
  cardTitle: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '600',
    fontFamily: Platform.select({
      ios: 'AvenirNext-DemiBold',
      android: 'sans-serif-medium',
    }),
  },
  errorText: {
    color: '#fecaca',
  },
  meta: {
    color: '#cbd5f5',
    fontSize: 13,
    fontFamily: Platform.select({
      ios: 'AvenirNext-Medium',
      android: 'sans-serif',
    }),
  },
});

export default App;
