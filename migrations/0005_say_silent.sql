-- /say: 1 to send without notifications (an "@silent" message), 0 to notify as normal.
ALTER TABLE say_drafts ADD COLUMN silent INTEGER NOT NULL DEFAULT 0;
