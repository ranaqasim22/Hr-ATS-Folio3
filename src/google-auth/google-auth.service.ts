import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';


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
    this.oauth2Client = new OAuth2Client(clientId, clientSecret);
    this.oauth2Client.setCredentials({ refresh_token: refreshToken });

    this.logger.log('GoogleAuthService initialized (single OAuth2 client created)');
  }

  onModuleInit() {
  }


  async getAccessToken(): Promise<string> {
    const { token } = await this.oauth2Client.getAccessToken();
    if (!token) {
      throw new Error('Failed to obtain Google access token from refresh token');
    }
    return token;
  }

  getClient(): OAuth2Client {
    return this.oauth2Client;
  }
}
