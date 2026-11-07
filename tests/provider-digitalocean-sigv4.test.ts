import { describe, expect, it } from 'vitest';
import {
  emptyPayloadHash,
  encodeS3Key,
  presignSigV4,
  signSigV4,
  type SigV4Credentials,
} from '@better-compute/provider-digitalocean';

// The Spaces signer against AWS's published Signature Version 4 vectors: the sigv4 test suite's
// get-vanilla family and the worked examples in the S3 API reference ("Examples: Signature
// Calculations in AWS Signature Version 4" and "Authenticating Requests: Using Query Parameters").

const suite: SigV4Credentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const s3: SigV4Credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const suiteDate = Date.UTC(2015, 7, 30, 12, 36, 0);
const s3Date = Date.UTC(2013, 4, 24, 0, 0, 0);

const signature = (authorization: string) => /Signature=([0-9a-f]{64})$/.exec(authorization)?.[1];

describe('signSigV4 (sigv4 test suite)', () => {
  it('get-vanilla', () => {
    const signed = signSigV4({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: {},
      payloadHash: emptyPayloadHash,
      credentials: suite,
      region: 'us-east-1',
      service: 'service',
      now: suiteDate,
      sendPayloadHash: false,
    });
    expect(signed.headers['x-amz-date']).toBe('20150830T123600Z');
    expect(signed.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('get-vanilla-query-order-key-case sorts the query by encoded key', () => {
    const signed = signSigV4({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/?Param2=value2&Param1=value1'),
      headers: {},
      payloadHash: emptyPayloadHash,
      credentials: suite,
      region: 'us-east-1',
      service: 'service',
      now: suiteDate,
      sendPayloadHash: false,
    });
    expect(signature(signed.headers.authorization!)).toBe(
      'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500',
    );
  });
});

describe('signSigV4 (S3 examples)', () => {
  it('GET Object with a range', () => {
    const signed = signSigV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      payloadHash: emptyPayloadHash,
      credentials: s3,
      region: 'us-east-1',
      service: 's3',
      now: s3Date,
    });
    expect(signed.headers['x-amz-content-sha256']).toBe(emptyPayloadHash);
    expect(signed.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('PUT Object with a key that needs encoding', () => {
    const body = new TextEncoder().encode('Welcome to Amazon S3.');
    const signed = signSigV4({
      method: 'PUT',
      url: new URL(`https://examplebucket.s3.amazonaws.com/${encodeS3Key('test$file.text')}`),
      headers: {
        date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      },
      payload: body,
      credentials: s3,
      region: 'us-east-1',
      service: 's3',
      now: s3Date,
    });
    expect(signed.headers['x-amz-content-sha256']).toBe(
      '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    );
    expect(signed.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, ' +
        'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });

  it('GET Bucket Lifecycle (an empty-valued subresource)', () => {
    const signed = signSigV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle'),
      headers: {},
      payloadHash: emptyPayloadHash,
      credentials: s3,
      region: 'us-east-1',
      service: 's3',
      now: s3Date,
    });
    expect(signature(signed.headers.authorization!)).toBe(
      'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    );
  });

  it('Get Bucket (List Objects)', () => {
    const signed = signSigV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'),
      headers: {},
      payloadHash: emptyPayloadHash,
      credentials: s3,
      region: 'us-east-1',
      service: 's3',
      now: s3Date,
    });
    expect(signature(signed.headers.authorization!)).toBe(
      '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  });

  it('presigns a GET with query parameters', () => {
    const url = presignSigV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      credentials: s3,
      region: 'us-east-1',
      service: 's3',
      now: s3Date,
      expiresInSeconds: 86400,
    });
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('86400');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });
});

describe('the signer refuses what it cannot sign', () => {
  it('rejects an expiry outside 1 s .. 7 days', () => {
    const base = {
      method: 'GET' as const,
      url: new URL('https://b.nyc3.digitaloceanspaces.com/k'),
      credentials: s3,
      region: 'us-east-1',
      service: 's3',
      now: s3Date,
    };
    expect(() => presignSigV4({ ...base, expiresInSeconds: 0 })).toThrow(/expires/i);
    expect(() => presignSigV4({ ...base, expiresInSeconds: 604_801 })).toThrow(/expires/i);
    expect(() => presignSigV4({ ...base, expiresInSeconds: 1.5 })).toThrow(/expires/i);
  });

  it('keeps the secret out of every header it returns', () => {
    const signed = signSigV4({
      method: 'GET',
      url: new URL('https://b.nyc3.digitaloceanspaces.com/k'),
      headers: {},
      payloadHash: emptyPayloadHash,
      credentials: s3,
      region: 'nyc3',
      service: 's3',
      now: s3Date,
    });
    expect(JSON.stringify(signed)).not.toContain(s3.secretAccessKey);
  });
});

describe('encodeS3Key', () => {
  it('encodes each segment and keeps the slashes', () => {
    expect(encodeS3Key('a b/c+d/é~_.-')).toBe('a%20b/c%2Bd/%C3%A9~_.-');
    expect(encodeS3Key("x*(y)!'")).toBe('x%2A%28y%29%21%27');
  });
});
