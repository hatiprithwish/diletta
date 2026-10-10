-- Down for 20261010022301_diletta: restores the plain message_id index on feedback (M2-7 review: the unique
-- (message_id, chatbot_user_id) index covers message_id lookups, so it was dropped).
CREATE INDEX "IDX_feedback_message_id" ON "feedback" ("message_id");
