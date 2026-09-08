import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GoogleAuthService } from './google-auth.service';

/**
 * @Global() means Nest registers this module's exported providers on the
 * root injector. Import GoogleAuthModule ONCE in AppModule, and every other
 * module (CalendarModule, SheetsModule, DriveModule, ...) can inject
 * GoogleAuthService without importing this module again — and without
 * a second OAuth2Client / second refresh flow ever being created.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [GoogleAuthService],
  exports: [GoogleAuthService],
})
export class GoogleAuthModule {}
