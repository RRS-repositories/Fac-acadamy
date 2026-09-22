// A complete, valid, entirely synthetic environment for config tests.
// Values are placeholders; none of them are real credentials.
export const SECRET_TOKEN_VALUE = 'bot-token-synthetic-7f3a9c1e';
export const CRM_KEY_VALUE = 'crm-key-synthetic-0123456789abcdef-0123';
/** base64 of 32 synthetic bytes (0x01 x 32). */
export const MFA_KEY_VALUE = Buffer.alloc(32, 1).toString('base64');

export function validEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_NAME: 'academy_test',
    DB_USER: 'academy_app',
    DB_PASSWORD: 'db-password-synthetic',
    SESSION_SECRET: 'x'.repeat(40),
    ACADEMY_V2: 'false',
    STAGE1_AUTH_REQUIRED: 'false',
    CRM_AUTH_URL: 'http://localhost:3000/api/auth/academy-verify',
    CRM_AUTH_KEY: CRM_KEY_VALUE,
    MFA_ENCRYPTION_KEY: MFA_KEY_VALUE,
    SES_REGION: 'eu-west-2',
    SES_SENDER: 'academy@example.com',
    S3_BUCKET: 'academy-test',
    S3_REGION: 'eu-west-2',
    MATTERMOST_URL: 'http://localhost:8065',
    MATTERMOST_BOT_TOKEN: SECRET_TOKEN_VALUE,
    MATTERMOST_IT_CHANNEL_ID: 'channel-synthetic',
    PUBLIC_BASE_URL: 'http://localhost:5173',
  };
}

export const REQUIRED_VARS = [
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'SESSION_SECRET',
  'ACADEMY_V2',
  'STAGE1_AUTH_REQUIRED',
  'CRM_AUTH_URL',
  'CRM_AUTH_KEY',
  'MFA_ENCRYPTION_KEY',
  'SES_REGION',
  'SES_SENDER',
  'S3_BUCKET',
  'S3_REGION',
  'MATTERMOST_URL',
  'MATTERMOST_BOT_TOKEN',
  'MATTERMOST_IT_CHANNEL_ID',
  'PUBLIC_BASE_URL',
] as const;
