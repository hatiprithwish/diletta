-- Down for 20261009034017_diletta: drops the one-row-per-Think-message index on messages (M2-2).
DROP INDEX "UNQ_messages_conversation_id_session_message_id";
