// A complete, valid, entirely synthetic environment for config tests.
// Values are placeholders; none of them are real credentials.
export const SECRET_TOKEN_VALUE = 'bot-token-synthetic-7f3a9c1e';

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
  'SES_REGION',
  'SES_SENDER',
  'S3_BUCKET',
  'S3_REGION',
  'MATTERMOST_URL',
  'MATTERMOST_BOT_TOKEN',
  'MATTERMOST_IT_CHANNEL_ID',
  'PUBLIC_BASE_URL',
] as const;
