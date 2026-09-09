import { Module } from '@nestjs/common';
import { SheetsService } from './sheets.service';
import { SheetsController } from './sheets.controller';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  controllers: [SheetsController],
  providers: [SheetsService],
  exports: [SheetsService],
})
export class SheetsModule {}