// Response builders for the AWS emulator. Values are escaped; callers pass raw strings.

let counter = 0;
export const requestId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

export function esc(value: string | number | boolean): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `<tag>value</tag>`, or '' when value is undefined. */
export function el(tag: string, value: string | number | boolean | undefined): string {
  return value === undefined ? '' : `<${tag}>${esc(value)}</${tag}>`;
}

/** `<tag><item>…</item>…</tag>` from pre-built item bodies. */
export function items(tag: string, bodies: readonly string[]): string {
  return `<${tag}>${bodies.map((body) => `<item>${body}</item>`).join('')}</${tag}>`;
}

const xmlHeaders = (id: string) => ({
  'content-type': 'text/xml;charset=UTF-8',
  'x-amzn-requestid': id,
});

export function ec2Response(action: string, inner: string): Response {
  const id = requestId();
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<${action}Response xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>${id}</requestId>${inner}</${action}Response>`,
    { status: 200, headers: xmlHeaders(id) },
  );
}

export function ec2Error(code: string, message: string, status = 400): Response {
  const id = requestId();
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Errors><Error><Code>${esc(code)}</Code><Message>${esc(message)}</Message></Error></Errors><RequestID>${id}</RequestID></Response>`,
    { status, headers: xmlHeaders(id) },
  );
}

export function queryResponse(action: string, ns: string, inner: string): Response {
  const id = requestId();
  return new Response(
    `<${action}Response xmlns="${esc(ns)}"><${action}Result>${inner}</${action}Result><ResponseMetadata><RequestId>${id}</RequestId></ResponseMetadata></${action}Response>`,
    { status: 200, headers: xmlHeaders(id) },
  );
}

export function queryError(
  code: string,
  message: string,
  type: 'Sender' | 'Receiver' = 'Sender',
  status = 400,
): Response {
  const id = requestId();
  return new Response(
    `<ErrorResponse><Error><Type>${type}</Type><Code>${esc(code)}</Code><Message>${esc(message)}</Message></Error><RequestId>${id}</RequestId></ErrorResponse>`,
    { status, headers: xmlHeaders(id) },
  );
}

export function jsonError(code: string, message: string, status = 400): Response {
  return new Response(JSON.stringify({ __type: code, message }), {
    status,
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amzn-requestid': requestId() },
  });
}

/** A rest-json error (EKS, …): the code in `x-amzn-errortype`, the message in the body. */
export function restJsonError(code: string, message: string, status = 400): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-amzn-errortype': `${code}:http://internal.amazon.com/coral/com.amazonaws.eks/`,
      'x-amzn-requestid': requestId(),
    },
  });
}
