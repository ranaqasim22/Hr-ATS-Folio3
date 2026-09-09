import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GoogleCalendarModule } from '@qte/nest-google-calendar';
import { CalendarService } from './calendar.service';
import { CalendarController } from './calendar.controller';

@Module({
  imports: [ConfigModule, GoogleCalendarModule],
  controllers: [CalendarController],
  providers: [CalendarService],
  exports: [CalendarService], // so Sheets/Drive/AI-testing modules (other members) can reuse it
})
export class CalendarModule {}
