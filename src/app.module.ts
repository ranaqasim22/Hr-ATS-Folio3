import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SheetsModule } from './sheets/sheets.module';
import { GoogleAuthModule } from './google-auth/google-auth.module';
import { CalendarModule } from './calendar/calendar.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    GoogleAuthModule,
    CalendarModule,
    SheetsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}