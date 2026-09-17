import { Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';
import * as mammoth from 'mammoth';
import { GoogleAuthService } from '../google-auth/google-auth.service';

@Injectable()
export class DriveService {
  private readonly logger = new Logger(DriveService.name);
  private drive: any;

  constructor(private readonly googleAuthService: GoogleAuthService) {
    this.drive = google.drive({
      version: 'v3',
      auth: this.googleAuthService.getClient(),
    });
  }

  async uploadResume(filePath: string, fileName: string): Promise<string> {
    try {
      const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
      const media = { body: fs.createReadStream(filePath) };

      const driveResponse = await this.drive.files.create({
        requestBody: { name: fileName, parents: [folderId] },
        media,
        fields: 'id',
      });

      const fileId = driveResponse.data.id;
      await this.drive.permissions.create({
        fileId,
        requestBody: { role: 'reader', type: 'anyone' },
      });

      const link = `https://drive.google.com/file/d/${fileId}/view`;
      this.logger.log(`Resume uploaded: ${link}`);
      return link;
    } catch (error) {
      this.logger.error(`Failed to upload: ${error.message}`);
      return 'No Resume Found';
    }
  }

  async extractTextFromResume(filePath: string): Promise<string> {
    try {
      const ext = path.extname(filePath).toLowerCase();

      if (ext === '.pdf') {
        const buffer = fs.readFileSync(filePath);
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(buffer);
        return data.text;
      }

      if (ext === '.docx') {
        const result = await mammoth.extractRawText({ path: filePath });
        return result.value;
      }

      if (ext === '.doc') {
        const wordExtractor = require('word-extractor');
        const extractor = new wordExtractor();
        const doc = await extractor.extract(filePath);
        return doc.getBody();
      }

      return '';
    } catch (error) {
      this.logger.error(`Failed to extract: ${error.message}`);
      return '';
    }
  }

  async downloadAttachment(
    fileUrl: string,
    _fileName: string,
  ): Promise<string> {
    try {
      let fileId = '';

      if (fileUrl.includes('drive.google.com/file/d/')) {
        fileId = fileUrl.split('/file/d/')[1].split('/')[0];
      } else if (fileUrl.includes('drive.google.com/open?id=')) {
        fileId = fileUrl.split('open?id=')[1].split('&')[0];
      } else if (fileUrl.includes('drive.google.com/uc?export=download&id=')) {
        fileId = fileUrl.split('id=')[1].split('&')[0];
      }

      if (!fileId) {
        throw new Error('Could not extract file ID from URL');
      }

      this.logger.log(`Checking Drive file: ${fileId}`);

      const metadata = await this.drive.files.get({
        fileId,
        fields: 'id,name,mimeType,size',
      });

      const fileName = metadata.data.name || 'resume';
      const mimeType = metadata.data.mimeType || '';

      this.logger.log(`Drive file: ${fileName} | MIME type: ${mimeType}`);

      let buffer: Buffer;
      let finalFileName = fileName;

      if (mimeType === 'application/vnd.google-apps.document') {
        this.logger.log('Google Docs detected. Exporting as DOCX...');
        const response = await this.drive.files.export(
          {
            fileId,
            mimeType:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          },
          { responseType: 'arraybuffer' },
        );
        buffer = Buffer.from(response.data);
        finalFileName = `${fileName}.docx`;
      } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
        throw new Error(`"${fileName}" is a Google Sheet, not a resume.`);
      } else if (mimeType === 'application/vnd.google-apps.presentation') {
        throw new Error(`"${fileName}" is a Google Slides presentation.`);
      } else {
        this.logger.log('Normal Drive file detected. Downloading...');
        const response = await this.drive.files.get(
          { fileId, alt: 'media' },
          { responseType: 'arraybuffer' },
        );
        buffer = Buffer.from(response.data);
      }

      if (!buffer || buffer.length < 100) {
        throw new Error(
          `Downloaded file is invalid or empty: ${finalFileName}`,
        );
      }

      const safeName = (finalFileName || 'resume').replace(
        /[<>:"/\\|?*]/g,
        '_',
      );
      const tempPath = path.join(
        __dirname,
        `../temp_${Date.now()}_${safeName}`,
      );
      fs.writeFileSync(tempPath, buffer);

      this.logger.log(
        `Downloaded attachment: ${tempPath} (${buffer.length} bytes)`,
      );
      return tempPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to download: ${message}`);
      return '';
    }
  }

  async processResume(event: any): Promise<string> {
    if (event.description) {
      const linkMatch = event.description.match(
        /https?:\/\/[^\s]+\.(pdf|doc|docx)/i,
      );
      if (linkMatch) {
        this.logger.log(`Resume link found in description: ${linkMatch[0]}`);
        return linkMatch[0];
      }
    }

    if (event.attachments && event.attachments.length > 0) {
      const attachment = event.attachments[0];
      const tempPath = await this.downloadAttachment(
        attachment.fileUrl,
        attachment.title || 'resume.pdf',
      );
      if (tempPath) {
        const link = await this.uploadResume(
          tempPath,
          attachment.title || 'resume.pdf',
        );
        fs.unlinkSync(tempPath);
        return link;
      }
    }

    this.logger.log('No resume found');
    return 'No Resume Found';
  }
}
