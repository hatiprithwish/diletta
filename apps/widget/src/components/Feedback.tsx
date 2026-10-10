import { ThumbsDown, ThumbsUp } from "@phosphor-icons/react";
import { Button } from "@app/ui/components/button";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Thumbs on a finished reply. The visitor can switch between them; a pressed one shows filled.
export default function Feedback({ messageId, rating, onRate }: Schemas.WidgetFeedbackProps) {
  const isUp = rating === Schemas.FeedbackRatingIntEnum.Up;
  const isDown = rating === Schemas.FeedbackRatingIntEnum.Down;
  return (
    <div className="flex gap-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Helpful"
        aria-pressed={isUp}
        onClick={() => onRate(messageId, Schemas.FeedbackRatingIntEnum.Up)}
        className="text-muted-foreground aria-pressed:text-foreground"
      >
        <ThumbsUp weight={isUp ? "fill" : "regular"} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Not helpful"
        aria-pressed={isDown}
        onClick={() => onRate(messageId, Schemas.FeedbackRatingIntEnum.Down)}
        className="text-muted-foreground aria-pressed:text-foreground"
      >
        <ThumbsDown weight={isDown ? "fill" : "regular"} />
      </Button>
    </div>
  );
}
