-- Migration: add document_number to estimates
-- Stores the NetSuite transaction ID (e.g. "EST-0042") returned after portal→NS sync

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS document_number VARCHAR(100);
