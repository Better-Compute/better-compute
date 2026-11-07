// Secrets Manager and SSM Parameter Store fakes.
import { AwsEmulator, EmuError, jsonResponse } from './index.js';

export interface FakeSecret {
  name: string;
  value?: string;
  binary?: string;
  kmsKeyId?: string;
  tags: { Key: string; Value: string }[];
  versions: number;
}

export function secretsManagerFake(emu: AwsEmulator) {
  const secrets = new Map<string, FakeSecret>();
  const deletions: { name: string; recoveryWindowDays?: number; force?: boolean }[] = [];
  emu.register('secretsmanager', {
    protocol: 'json',
    handle(request) {
      const body = JSON.parse(Buffer.from(request.body).toString('utf8')) as Record<string, unknown>;
      switch (request.operation) {
        case 'CreateSecret': {
          const name = String(body.Name);
          if (secrets.has(name)) throw new EmuError('ResourceExistsException', 'exists');
          secrets.set(name, {
            name,
            value: body.SecretString as string | undefined,
            kmsKeyId: body.KmsKeyId as string | undefined,
            tags: (body.Tags as FakeSecret['tags']) ?? [],
            versions: 1,
          });
          return jsonResponse({ ARN: `arn:aws:secretsmanager:us-east-1:111111111111:secret:${name}-AbCdEf`, Name: name });
        }
        case 'PutSecretValue': {
          const secret = secrets.get(String(body.SecretId));
          if (!secret) throw new EmuError('ResourceNotFoundException', 'Secrets Manager cannot find the specified secret.');
          secret.value = body.SecretString as string;
          secret.versions += 1;
          return jsonResponse({ Name: secret.name });
        }
        case 'GetSecretValue': {
          const secret = secrets.get(String(body.SecretId));
          if (!secret) throw new EmuError('ResourceNotFoundException', 'Secrets Manager cannot find the specified secret.');
          return jsonResponse({
            Name: secret.name,
            ...(secret.value !== undefined ? { SecretString: secret.value } : {}),
            ...(secret.binary !== undefined ? { SecretBinary: secret.binary } : {}),
          });
        }
        case 'DeleteSecret': {
          const name = String(body.SecretId);
          if (!secrets.has(name)) throw new EmuError('ResourceNotFoundException', 'Secrets Manager cannot find the specified secret.');
          secrets.delete(name);
          deletions.push({
            name,
            recoveryWindowDays: body.RecoveryWindowInDays as number | undefined,
            force: body.ForceDeleteWithoutRecovery as boolean | undefined,
          });
          return jsonResponse({ Name: name });
        }
        default:
          throw new EmuError('UnknownOperationException', request.operation);
      }
    },
  });
  return { secrets, deletions };
}

export interface FakeParameter {
  name: string;
  value: string;
  type: string;
  keyId?: string;
  tier: string;
  tags: { Key: string; Value: string }[];
}

export function parameterStoreFake(emu: AwsEmulator) {
  const parameters = new Map<string, FakeParameter>();
  emu.register('ssm', {
    protocol: 'json',
    handle(request) {
      const body = JSON.parse(Buffer.from(request.body).toString('utf8')) as Record<string, unknown>;
      switch (request.operation) {
        case 'PutParameter': {
          const name = String(body.Name);
          const tier = (body.Tier as string | undefined) ?? 'Standard';
          const value = String(body.Value);
          const limit = tier === 'Advanced' ? 8192 : 4096;
          if (Buffer.byteLength(value) > limit) throw new EmuError('ParameterMaxVersionLimitExceeded', 'too large');
          if (parameters.has(name) && body.Overwrite !== true) throw new EmuError('ParameterAlreadyExists', 'exists');
          if (parameters.has(name) && body.Tags) throw new EmuError('ValidationException', 'tags with overwrite');
          parameters.set(name, {
            name,
            value,
            type: String(body.Type),
            keyId: body.KeyId as string | undefined,
            tier,
            tags: (body.Tags as FakeParameter['tags']) ?? parameters.get(name)?.tags ?? [],
          });
          return jsonResponse({ Version: 1, Tier: tier });
        }
        case 'GetParameter': {
          const parameter = parameters.get(String(body.Name));
          if (!parameter) throw new EmuError('ParameterNotFound', 'not found');
          if (parameter.type === 'SecureString' && body.WithDecryption !== true)
            return jsonResponse({ Parameter: { Name: parameter.name, Type: parameter.type, Value: 'AQICAH-encrypted' } });
          return jsonResponse({ Parameter: { Name: parameter.name, Type: parameter.type, Value: parameter.value } });
        }
        case 'DeleteParameter': {
          if (!parameters.delete(String(body.Name))) throw new EmuError('ParameterNotFound', 'not found');
          return jsonResponse({});
        }
        default:
          throw new EmuError('UnknownOperationException', request.operation);
      }
    },
  });
  return { parameters };
}
