import { describe, expect, it } from 'vitest';
import { ComputeError } from '@better-compute/core';
import { parseXml, serializeAwsQuery, serializeEc2Query } from '@better-compute/aws-core';

const describeInstances = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <requestId>8f7724cf-496f-496e-8fe3-example</requestId>
  <reservationSet>
    <item>
      <reservationId>r-1234567890abcdef0</reservationId>
      <instancesSet>
        <item>
          <instanceId>i-0abc12345678def01</instanceId>
          <instanceState><code>16</code><name>running</name></instanceState>
        </item>
      </instancesSet>
    </item>
  </reservationSet>
</DescribeInstancesResponse>`;

function reasonOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ComputeError);
    const failure = error as ComputeError;
    expect(failure.code).toBe('PROVIDER_ERROR');
    expect(failure.message).toBe('malformed XML from AWS');
    return failure.details?.reason;
  }
  throw new Error('expected parseXml to throw');
}

describe('parseXml', () => {
  it('parses an EC2 DescribeInstances response', () => {
    const doc = parseXml(describeInstances);
    expect(doc.name).toBe('DescribeInstancesResponse');
    expect(doc.textOf('requestId')).toBe('8f7724cf-496f-496e-8fe3-example');
    const instance = doc.items('reservationSet')[0]!.items('instancesSet')[0]!;
    expect(instance.textOf('instanceId')).toBe('i-0abc12345678def01');
    expect(instance.child('instanceState')?.textOf('name')).toBe('running');
  });

  it('decodes the five predefined entities and numeric references', () => {
    const doc = parseXml('<a>&amp;&lt;&gt;&quot;&apos;&#65;&#x42;</a>');
    expect(doc.text).toBe(`&<>"'AB`);
  });

  it('refuses DOCTYPE', () => {
    const body = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>';
    expect(reasonOf(() => parseXml(body))).toBe('doctype');
  });

  it('refuses a custom entity reference', () => {
    expect(reasonOf(() => parseXml('<x>&a;</x>'))).toBe('entity');
  });

  it('refuses depth beyond the limit', () => {
    const nest = (depth: number) => '<a>'.repeat(depth) + '</a>'.repeat(depth);
    expect(reasonOf(() => parseXml(nest(65)))).toBe('depth');
    expect(parseXml(nest(64)).name).toBe('a');
  });

  it('refuses documents over maxBytes', () => {
    expect(reasonOf(() => parseXml('<a>0123456789</a>', { maxBytes: 8 }))).toBe('size');
    // The limit counts UTF-8 bytes, not UTF-16 code units.
    expect(reasonOf(() => parseXml('<a>éééé</a>', { maxBytes: 10 }))).toBe('size');
  });

  it('refuses syntax errors', () => {
    expect(reasonOf(() => parseXml('<a><b></a></b>'))).toBe('syntax');
    expect(reasonOf(() => parseXml('<a>'))).toBe('syntax');
    expect(reasonOf(() => parseXml(''))).toBe('syntax');
    expect(reasonOf(() => parseXml('<a/><b/>'))).toBe('syntax');
  });

  it('keeps CDATA text, skips comments, strips prefixes and reads attributes', () => {
    const doc = parseXml(
      `<s:Root xmlns:s="urn:x" s:id="7" other='q'><!-- note --><s:Leaf><![CDATA[<raw & text>]]></s:Leaf><Empty/></s:Root>`,
    );
    expect(doc.name).toBe('Root');
    expect(doc.attributes).toEqual({ 'xmlns:s': 'urn:x', id: '7', other: 'q' });
    expect(doc.textOf('Leaf')).toBe('<raw & text>');
    expect(doc.child('Empty')?.text).toBe('');
    expect(doc.textOf('Missing')).toBeUndefined();
  });

  it('items reads both item and member lists', () => {
    const doc = parseXml(
      '<r><a><item><v>1</v></item><item><v>2</v></item></a><b><member><v>3</v></member></b></r>',
    );
    expect(doc.items('a').map((item) => item.textOf('v'))).toEqual(['1', '2']);
    expect(doc.items('b').map((item) => item.textOf('v'))).toEqual(['3']);
    expect(doc.items('absent')).toEqual([]);
    expect(doc.all('a')).toHaveLength(1);
  });
});

describe('query serializers', () => {
  it('serializes EC2 lists, nested structures and booleans', () => {
    expect(
      serializeEc2Query('DescribeInstances', '2016-11-15', {
        Filter: [{ Name: 'tag:a', Value: ['x', 'y'] }],
        DryRun: false,
      }),
    ).toBe(
      'Action=DescribeInstances&DryRun=false&Filter.1.Name=tag%3Aa&Filter.1.Value.1=x&Filter.1.Value.2=y&Version=2016-11-15',
    );
  });

  it('omits undefined values', () => {
    const body = serializeEc2Query('A', '1', { Skip: undefined, MaxResults: 5, Ids: ['a', 'b'] });
    expect(body).toBe('Action=A&Ids.1=a&Ids.2=b&MaxResults=5&Version=1');
  });

  it('serializes awsQuery members', () => {
    expect(
      serializeAwsQuery('TagResource', '2010-05-08', { Tags: [{ Key: 'k', Value: 'v' }] }),
    ).toBe('Action=TagResource&Tags.member.1.Key=k&Tags.member.1.Value=v&Version=2010-05-08');
  });

  it('serializes awsQuery maps as entry key/value pairs', () => {
    const attributes = new Map([
      ['b', '2'],
      ['a', '1'],
    ]);
    expect(serializeAwsQuery('A', '1', { Attributes: attributes })).toBe(
      'Action=A&Attributes.entry.1.key=a&Attributes.entry.1.value=1&Attributes.entry.2.key=b&Attributes.entry.2.value=2&Version=1',
    );
    expect(() => serializeEc2Query('A', '1', { Attributes: attributes })).toThrow(ComputeError);
  });

  it('spells an empty awsQuery list as an empty value and omits it for EC2', () => {
    expect(serializeAwsQuery('A', '1', { Names: [] })).toBe('Action=A&Names=&Version=1');
    expect(serializeEc2Query('A', '1', { Names: [] })).toBe('Action=A&Version=1');
  });

  it('keeps Action and Version authoritative and refuses non-finite numbers', () => {
    expect(serializeEc2Query('Real', '2', { Action: 'Fake', Version: 'x' })).toBe(
      'Action=Real&Version=2',
    );
    expect(() => serializeEc2Query('A', '1', { N: Number.NaN })).toThrow(ComputeError);
  });

  it('percent-encodes per RFC 3986', () => {
    expect(serializeEc2Query('A', '1', { V: "a b~*!'()/é" })).toBe(
      'Action=A&V=a%20b~%2A%21%27%28%29%2F%C3%A9&Version=1',
    );
  });
});
