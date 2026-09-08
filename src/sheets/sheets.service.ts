import { Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import { ConfigService } from '@nestjs/config';
import { CalendarEventDto } from '../calendar/dto/calendar-event.dto';
import { Injectable } from '@nestjs/common';
import { GoogleSheetConnectorService } from '@icetee/nest-google-sheet-connector';
import { CalendarEventDto } from '../calendar/dto/calendar-event.dto'; 

const EVENT_ID_COLUMN_INDEX = 12;

export interface SyncResult {
  action: 'created' | 'updated';
  rowIndex: number;
}

@Injectable()
export class SheetsService {
  private readonly logger = new Logger(SheetsService.name);
  private sheets: any;

  constructor(private readonly configService: ConfigService) {
    // --- Smart Auth Logic: OAuth2 OR Service Account ---
    const serviceAccountKeyPath = this.configService.get<string>(
      'GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH',
    );
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET');
    const refreshToken = this.configService.get<string>('GOOGLE_REFRESH_TOKEN');

    if (serviceAccountKeyPath) {
      // 1. Use Service Account (if available)
      const auth = new google.auth.GoogleAuth({
        keyFile: serviceAccountKeyPath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      this.sheets = google.sheets({ version: 'v4', auth });
      this.logger.log('Sheets: Using Service Account authentication');
    } else if (clientId && clientSecret && refreshToken) {
      // 2. Use OAuth2 (if available)
      const auth = new google.auth.OAuth2(clientId, clientSecret);
      auth.setCredentials({ refresh_token: refreshToken });
      this.sheets = google.sheets({ version: 'v4', auth });
      this.logger.log('Sheets: Using OAuth2 authentication');
    } else {
      throw new Error(
        'Missing Google Sheets credentials. Set either GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH OR GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN.',
      );
    }
  }

  private getSpreadsheetId(): string {
    const id = this.configService.get<string>('GOOGLE_SHEET_ID');
  constructor(private readonly sheetConnector: GoogleSheetConnectorService) {}

  private getSpreadsheetId(): string {
    const id = process.env.GOOGLE_SHEET_ID;
    if (!id) {
      throw new Error('GOOGLE_SHEET_ID is not set in .env');
    }
    return id;
  }

  private getSheetName(): string {
    return this.configService.get<string>('GOOGLE_SHEET_NAME') || 'Sheet1';
    return process.env.GOOGLE_SHEET_NAME || 'Sheet1';
  }

  private getDataRange(): string {
    return `${this.getSheetName()}!A:M`;
  }

  private eventToRow(event: CalendarEventDto): any[] {
    return [
      event.candidateName ?? '',
      event.position ?? '',
      event.interviewStage ?? '',
      event.type ?? '',
      this.formatDate(event.date),
      event.time ?? '',
      event.location ?? '',
      Array.isArray(event.interviewers) ? event.interviewers.join(', ') : event.interviewers ?? '',
      event.recruiter ?? '',
      event.contactNumber ? `'${event.contactNumber}` : '',
      event.contactNumber ?? '',
      event.emailAddress ?? '',
      event.resumeLink ?? '',
      event.eventId,
    ];
  }

  private formatDate(date: string | Date | undefined): string {
    if (!date) return '';
  private formatDate(date: string | Date | undefined): string {
    if (!date) return '';

    if (typeof date === 'string') {
      const isoMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (isoMatch) {
        const [, year, month, day] = isoMatch;
        return `${day}/${month}/${year}`;
      }
    }
    const parsed = typeof date === 'string' ? new Date(date) : date;
    if (isNaN(parsed.getTime())) {
      return typeof date === 'string' ? date : '';
    }
    const day = String(parsed.getDate()).padStart(2, '0');
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const year = parsed.getFullYear();

    const parsed = typeof date === 'string' ? new Date(date) : date;

    if (isNaN(parsed.getTime())) {
      return typeof date === 'string' ? date : '';
    }

    const day = String(parsed.getDate()).padStart(2, '0');
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const year = parsed.getFullYear();

    return `${day}/${month}/${year}`;
  }

  async findRowByEventId(eventId: string): Promise<number | null> {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.getSpreadsheetId(),
      range: this.getDataRange(),
    });
    const rows = response.data.values || [];
    const index = rows.findIndex(
      (row: any[], i: number) => i > 0 && row[EVENT_ID_COLUMN_INDEX] === eventId,
    );
    const rows = await this.sheetConnector.readRange(
      this.getSpreadsheetId(),
      this.getDataRange(),
    );

    if (!rows) return null;

    const index = rows.findIndex(
      (row: any[], i: number) => i > 0 && row[EVENT_ID_COLUMN_INDEX] === eventId,
    );

    return index === -1 ? null : index + 1;
  }

  async appendRow(event: CalendarEventDto): Promise<void> {
    const row = this.eventToRow(event);
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.getSpreadsheetId(),
      range: this.getDataRange(),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
    await this.sheetConnector.addRow(
      this.getSpreadsheetId(),
      this.getDataRange(),
      [row],
      'USER_ENTERED',
    );
  }

  async updateRow(rowIndex: number, event: CalendarEventDto): Promise<void> {
    const row = this.eventToRow(event);
    const range = `${this.getSheetName()}!A${rowIndex}:M${rowIndex}`;
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.getSpreadsheetId(),
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
    await this.sheetConnector.writeRange(
      this.getSpreadsheetId(),
      range,
      [row],
      'USER_ENTERED',
    );
  }

  async syncEvent(event: CalendarEventDto): Promise<SyncResult> {
    if (!event.eventId) {
      throw new Error('eventId is required to sync an event to the sheet');
    }
    const existingRow = await this.findRowByEventId(event.eventId);

    const existingRow = await this.findRowByEventId(event.eventId);

    if (existingRow) {
      await this.updateRow(existingRow, event);
      return { action: 'updated', rowIndex: existingRow };
    }
    await this.appendRow(event);
    const newRow = await this.findRowByEventId(event.eventId);
    return { action: 'created', rowIndex: newRow as number };
  }
}

    await this.appendRow(event);
    const newRow = await this.findRowByEventId(event.eventId);

    return { action: 'created', rowIndex: newRow as number };
  }
}
