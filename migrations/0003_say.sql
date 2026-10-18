-- /say: the channel (and attachment, if any) chosen in the command, kept until the pop-up
-- text box is submitted, and deleted after 15 minutes at most. Keeping the channel here
-- rather than in the pop-up means it can only be one the user was checked against.
-- Nothing records who ran the command.
CREATE TABLE say_drafts (
  id TEXT PRIMARY KEY,                   -- random ID, also in the pop-up's custom_id
  channel_id TEXT NOT NULL,
  attachment_url TEXT,
  attachment_filename TEXT,
  attachment_size INTEGER,
  created_at INTEGER NOT NULL            -- ms timestamp
);
