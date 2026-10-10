-- Down for 20261010011607_diletta: drops the one-rating-per-reply-per-user index on feedback (M2-7).
DROP INDEX "UNQ_feedback_message_id_chatbot_user_id";
