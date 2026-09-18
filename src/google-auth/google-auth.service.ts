import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';

/**
 * GoogleAuthService
 * ------------------
 * Single, shared service account (JWT) client for the whole app.
 * - Reads GOOGLE_SERVICE_ACCOUNT_KEY_PATH from .env
 * - Creates exactly ONE JWT client instance (constructor runs once because
 *   this service + its module are marked @Global() and only ever provided once)
 * - Exposes getAccessToken() which returns a fresh access token,
 *   refreshing automatically as needed.
 *
 * Because this is @Global(), every other module (CalendarService,
 * SheetsService, DriveService, etc.) can inject GoogleAuthService
 * without re-importing GoogleAuthModule, and without ever creating
 * a second client instance.
 */
@Injectable()
export class GoogleAuthService implements OnModuleInit {
  private readonly logger = new Logger(GoogleAuthService.name);
  private jwtClient: InstanceType<typeof google.auth.JWT>;

  constructor(private readonly configService: ConfigService) {
const keyFile = this.configService.get<string>('GOOGLE_SERVICE_ACCOUNT_KEY_PATH');

if (!keyFile) {
  throw new Error(
    'Missing Google service account env var: GOOGLE_SERVICE_ACCOUNT_KEY_PATH',
  );
}

this.jwtClient = new google.auth.JWT({
  keyFile,
  scopes: [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/spreadsheets',
  ],
});
  }

  onModuleInit() {
    // Nothing to trigger here on purpose — we do NOT eagerly fetch a token
    // on startup. Tokens are pulled lazily, only when a real request needs one.
    // This is what prevents "multiple OAuth triggers on startup".
  }

  /**
   * Returns a valid access token, refreshing it under the hood if expired.
   * google-auth-library caches the token internally and only calls
   * Google's token endpoint again once it actually expires.
   */
  async getAccessToken(): Promise<string> {
    const { token } = await this.jwtClient.getAccessToken();
    if (!token) {
      throw new Error(
        'Failed to obtain Google access token from refresh token',
      );
    }
    return token;
  }

  /** Expose the raw client in case another service needs it directly (Drive, Sheets, etc). */
getClient(): InstanceType<typeof google.auth.JWT> {
  return this.jwtClient;
}
}
