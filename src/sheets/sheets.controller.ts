import { Controller, Post, Body } from '@nestjs/common';
import { SheetsService } from './sheets.service';
import { CalendarEventDto } from '../calendar/dto/calendar-event.dto';

@Controller('sheets')
export class SheetsController {
  constructor(private readonly sheetsService: SheetsService) {}

  @Post('sync')
  async syncEvent(@Body() event: CalendarEventDto) {
    return this.sheetsService.syncEvent(event);
  }
}