-- Migration Up: Add autoAssignOnTicketAction field to user preferences

BEGIN;

UPDATE "user_profiles" 
SET "preferences" = COALESCE("preferences", '{}'::jsonb) || '{"autoAssignOnTicketAction": true}'::jsonb
WHERE NOT (COALESCE("preferences", '{}'::jsonb) ? 'autoAssignOnTicketAction');

ALTER TABLE "user_profiles" ALTER COLUMN "preferences" SET DEFAULT '{"autoAssignOnTicketAction":true}'::jsonb;

COMMIT;