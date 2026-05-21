/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

beforeAll(() => {
  (global as { __IS_JEST__?: boolean }).__IS_JEST__ = true;
});

afterAll(() => {
  delete (global as { __IS_JEST__?: boolean }).__IS_JEST__;
});

jest.mock('@klaappinc/react-native-nitro-protobuf', () => ({
  NitroProtobuf: {
    encode: () => new ArrayBuffer(0),
    decode: () => ({ ok: true }),
    listMessages: () => ['acme.User'],
  },
}));

test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});
