import { Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import { ConfigService } from '@nestjs/config';
import { CalendarEventDto } from '../calendar/dto/calendar-event.dto';

const EVENT_ID_COLUMN_INDEX = 12;
const UPDATED_AT_COLUMN_INDEX = 14;

export interface SyncResult {
  action: 'created' | 'updated';
  rowIndex: number;
}

@Injectable()
export class SheetsService {
  private readonly logger = new Logger(SheetsService.name);
  private sheets: any;

  constructor(private readonly configService: ConfigService) {
    const serviceAccountKeyPath = this.configService.get<string>(
      'GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH',
    );
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET');
    const refreshToken = this.configService.get<string>('GOOGLE_REFRESH_TOKEN');

    if (serviceAccountKeyPath) {
      const auth = new google.auth.GoogleAuth({
        keyFile: serviceAccountKeyPath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      this.sheets = google.sheets({ version: 'v4', auth });
      this.logger.log('Sheets: Using Service Account authentication');
    } else if (clientId && clientSecret && refreshToken) {
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
    if (!id) {
      throw new Error('GOOGLE_SHEET_ID is not set in .env');
    }
    return id;
  }

  private getSheetName(): string {
    return this.configService.get<string>('GOOGLE_SHEET_NAME') || 'Sheet1';
  }

  // Widened from A:N to A:O — column O now stores "Updated At"
  private getDataRange(): string {
    return `${this.getSheetName()}!A:O`;
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
      event.emailAddress ?? '',
      event.resumeLink ?? '',
      event.eventId,
      event.status ?? 'Active',
      event.updatedAt ?? '', // new: column O — raw ISO timestamp, used by getStoredUpdatedAtMap()
    ];
  }

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
    return `${day}/${month}/${year}`;
  }

  private parseSheetDate(date: string): Date | null {
    const match = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);

    if (!match) {
      return null;
    }

    const [, day, month, year] = match;

    return new Date(Number(year), Number(month) - 1, Number(day));
  }

  private async getSheetId(): Promise<number> {
    const spreadsheetId = this.getSpreadsheetId();
    const sheetName = this.getSheetName();

    const response = await this.sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties',
    });

    const sheet = response.data.sheets?.find(
      (sheet: any) => sheet.properties?.title === sheetName,
    );

    if (!sheet?.properties) {
      throw new Error(`Sheet "${sheetName}" not found`);
    }

    return sheet.properties.sheetId;
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
    return index === -1 ? null : index + 1;
  }

  /**
   * Reports back what updatedAt value is currently stored per eventId —
   * a plain read, no comparison logic here. Whoever calls this (Member 4's
   * TrackerService, then Member 1's CalendarService) decides what to do
   * with it; this method's only job is to say what the Sheet already knows.
   */
  async getStoredUpdatedAtMap(): Promise<Record<string, string>> {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.getSpreadsheetId(),
      range: this.getDataRange(),
    });

    const rows = response.data.values || [];
    const map: Record<string, string> = {};

    for (let i = 1; i < rows.length; i++) {
      const eventId = rows[i]?.[EVENT_ID_COLUMN_INDEX];
      const updatedAt = rows[i]?.[UPDATED_AT_COLUMN_INDEX];

      if (eventId) {
        map[eventId] = updatedAt || '';
      }
    }

    return map;
  }

  async appendRow(event: CalendarEventDto): Promise<void> {
    const spreadsheetId = this.getSpreadsheetId();
    const sheetName = this.getSheetName();
    const newRow = this.eventToRow(event);

    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:O`,
    });

    const rows = response.data.values || [];

    let insertAtRow = rows.length + 1;

    const newEventDate = this.parseSheetDate(this.formatDate(event.date));

    for (let i = 1; i < rows.length; i++) {
      const existingDate = rows[i]?.[4];

      if (!existingDate) {
        continue;
      }

      const existingEventDate = this.parseSheetDate(existingDate);

      if (
        newEventDate &&
        existingEventDate &&
        newEventDate.getTime() < existingEventDate.getTime()
      ) {
        insertAtRow = i + 1;
        break;
      }
    }

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: {
                sheetId: await this.getSheetId(),
                dimension: 'ROWS',
                startIndex: insertAtRow - 1,
                endIndex: insertAtRow,
              },
              inheritFromBefore: false,
            },
          },
        ],
      },
    });

    await this.sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A${insertAtRow}:O${insertAtRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [newRow],
      },
    });
  }

  async deleteRow(rowIndex: number): Promise<void> {
    const spreadsheetId = this.getSpreadsheetId();
    const sheetId = await this.getSheetId();

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: 'ROWS',
                startIndex: rowIndex - 1,
                endIndex: rowIndex,
              },
            },
          },
        ],
      },
    });

    this.logger.log(`Deleted row ${rowIndex} (will be re-inserted with fresh data)`);
  }

  async updateRow(rowIndex: number, event: CalendarEventDto): Promise<void> {
    const row = this.eventToRow(event);
    const range = `${this.getSheetName()}!A${rowIndex}:O${rowIndex}`;
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.getSpreadsheetId(),
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
  }

  async syncEvent(event: CalendarEventDto): Promise<SyncResult> {
    if (!event.eventId) {
      throw new Error('eventId is required to sync an event to the sheet');
    }

    const existingRow = await this.findRowByEventId(event.eventId);

    if (existingRow) {
      await this.deleteRow(existingRow);
      await this.appendRow(event);
      const newRow = await this.findRowByEventId(event.eventId);
      return { action: 'updated', rowIndex: newRow as number };
    }

    await this.appendRow(event);
    const newRow = await this.findRowByEventId(event.eventId);
    return { action: 'created', rowIndex: newRow as number };
  }
}