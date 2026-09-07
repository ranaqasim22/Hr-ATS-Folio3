import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GoogleCalendarModule } from '@qte/nest-google-calendar';
import { CalendarService } from './calendar.service';
import { CalendarController } from './calendar.controller';

@Module({
  imports: [ConfigModule, GoogleCalendarModule],
  controllers: [CalendarController],
  providers: [CalendarService],
  exports: [CalendarService], 
})
export class CalendarModule {}
