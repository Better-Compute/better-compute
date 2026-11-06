// Redaction of AWS secrets from any string built from a request or response. Applied to every
// error message aws-core produces; callers apply it to anything they log from a response.

const patterns: readonly [RegExp, string][] = [
  // Access key ids: long-term (AKIA) and temporary (ASIA), plus the other documented prefixes.
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|APKA|ABIA|ACCA)[A-Z0-9]{12,}\b/g, '[REDACTED-KEY-ID]'],
  // Signatures and tokens in headers and query strings.
  [/(Signature=)[0-9a-fA-F]+/g, '$1[REDACTED]'],
  [/(X-Amz-Signature=)[^&\s"']+/gi, '$1[REDACTED]'],
  [/(X-Amz-Security-Token=)[^&\s"']+/gi, '$1[REDACTED]'],
  [/(X-Amz-Credential=)[^&\s"']+/gi, '$1[REDACTED]'],
  [/(x-amz-security-token\s*:\s*)[^\s,;"']+/gi, '$1[REDACTED]'],
  [/(x-aws-ec2-metadata-token\s*:\s*)[^\s,;"']+/gi, '$1[REDACTED]'],
  [/(authorization\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]'],
  [/(Credential=)[^,\s]+/g, '$1[REDACTED]'],
  // Credential JSON (STS, IMDS, the container endpoint) and their XML forms.
  [
    /("(?:SecretAccessKey|secretAccessKey|SessionToken|sessionToken|Token|token|AccessKeyId|accessKeyId)"\s*:\s*")[^"]*(")/g,
    '$1[REDACTED]$2',
  ],
  [/(<(SecretAccessKey|SessionToken|AccessKeyId)>)[^<]*(<\/\2>)/g, '$1[REDACTED]$3'],
];

/** Removes access key ids, secrets, session tokens, signatures and IMDS tokens from `text`. */
export function redactAws(text: string): string {
  let out = String(text);
  for (const [pattern, replacement] of patterns) out = out.replace(pattern, replacement);
  return out;
}
