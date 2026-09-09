import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';

/**
 * GoogleAuthService
 * ------------------
 * Single, shared OAuth2 client for the whole app.
 * - Reads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN from .env
 * - Creates exactly ONE OAuth2Client instance (constructor runs once because
 *   this service + its module are marked @Global() and only ever provided once)
 * - Exposes getAccessToken() which returns a fresh access token,
 *   refreshing automatically via the refresh_token when needed.
 *
 * Because this is @Global(), every other module (CalendarService, etc.)
 * can inject GoogleAuthService without re-importing GoogleAuthModule,
 * and without ever triggering a second OAuth flow on startup.
 */
@Injectable()
export class GoogleAuthService implements OnModuleInit {
  private readonly logger = new Logger(GoogleAuthService.name);
  private oauth2Client: OAuth2Client;

  constructor(private readonly configService: ConfigService) {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET');
    const refreshToken = this.configService.get<string>('GOOGLE_REFRESH_TOKEN');

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        'Missing Google OAuth env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN',
      );
    }

    // Exactly ONE OAuth2Client for the entire app lifetime.
    this.oauth2Client = new OAuth2Client(clientId, clientSecret);
    this.oauth2Client.setCredentials({ refresh_token: refreshToken });

    this.logger.log('GoogleAuthService initialized (single OAuth2 client created)');
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
    const { token } = await this.oauth2Client.getAccessToken();
    if (!token) {
      throw new Error('Failed to obtain Google access token from refresh token');
    }
    return token;
  }

  /** Expose the raw client in case another service needs it directly (Drive, Sheets, etc). */
  getClient(): OAuth2Client {
    return this.oauth2Client;
  }
}
