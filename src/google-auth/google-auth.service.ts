import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import type { JWT } from 'google-auth-library';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
];

@Injectable()
export class GoogleAuthService implements OnModuleInit {
  private readonly logger = new Logger(GoogleAuthService.name);
  // 👇 Type is now inferred from `googleapis`'s own bundled auth library,
  // not the standalone `google-auth-library` package — this is what
  // fixes the "GoogleAuth<AuthClient> is not assignable" TS error.
  private readonly googleAuth: InstanceType<typeof google.auth.GoogleAuth>;

  constructor(private readonly configService: ConfigService) {
    const keyFilePath = this.configService.get<string>('GOOGLE_SERVICE_ACCOUNT_KEY_PATH');
    const keyJson = this.configService.get<string>('GOOGLE_SERVICE_ACCOUNT_KEY');

    if (!keyFilePath && !keyJson) {
      throw new Error(
        'Missing Google service account credentials: set either GOOGLE_SERVICE_ACCOUNT_KEY_PATH ' +
          '(path to the JSON key file) or GOOGLE_SERVICE_ACCOUNT_KEY (raw JSON string) in .env',
      );
    }

    this.googleAuth = new google.auth.GoogleAuth({
      keyFile: keyFilePath || undefined,
      credentials: keyJson ? JSON.parse(keyJson) : undefined,
      scopes: SCOPES,
    });

    this.logger.log(
      'GoogleAuthService initialized (service account — no OAuth consent or refresh token needed)',
    );
  }

  onModuleInit() {
    // Nothing to trigger here on purpose — no eager token fetch on startup.
  }

  async getAccessToken(): Promise<string> {
    const client = await this.googleAuth.getClient();
    const tokenResponse = await client.getAccessToken();

    const token =
      typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;

    if (!token) {
      throw new Error('Failed to obtain Google access token from service account');
    }

    return token;
  }

  async getClient(): Promise<JWT> {
    return this.googleAuth.getClient() as unknown as Promise<JWT>;
  }

getGoogleAuth(): any {
  return this.googleAuth;
}
}