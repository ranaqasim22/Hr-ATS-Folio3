import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { CalendarService } from './calendar.service';
import { CalendarEventDto } from './dto/calendar-event.dto';

@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  @Get('events')
  async getEvents(
    @Query('from') from: string,
    @Query('to') to: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const timeMin = from ? new Date(from) : undefined;
    const timeMax = to ? new Date(to) : undefined;

    const events: CalendarEventDto[] = await this.calendarService.getInterviewEvents(
      timeMin,
      timeMax,
    );

    const wantsHtml = (req.headers.accept || '').includes('text/html');

    if (wantsHtml) {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      return res.send(this.renderLivePage(from, to));
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.json(events);
  }

  private renderLivePage(from?: string, to?: string): string {
    const fromParam = from || '';
    const toParam = to || '';

    return `<!DOCTYPE html>
<html>
<head>
  <title>Calendar Events</title>
  <style>
    body { font-family: monospace; background: #fff; margin: 20px; }
    pre { white-space: pre-wrap; word-break: break-word; }
    #ts { color: #888; font-size: 12px; margin-bottom: 10px; }
  </style>
</head>
<body>
  <div id="ts">Loading...</div>
  <pre id="output"></pre>

  <script>
    async function fetchData() {
      try {
        const res = await fetch(
          '/calendar/events?from=${fromParam}&to=${toParam}&_=' + Date.now(),
          { headers: { Accept: 'application/json' }, cache: 'no-store' }
        );
        const data = await res.json();
        document.getElementById('output').textContent = JSON.stringify(data, null, 2);
        document.getElementById('ts').textContent = 'Last checked: ' + new Date().toLocaleTimeString();
      } catch (err) {
        document.getElementById('ts').textContent = 'Error fetching data';
        console.error(err);
      }
    }

    fetchData();
    setInterval(fetchData, 600000); 
  </script>
</body>
</html>`;
  }
}