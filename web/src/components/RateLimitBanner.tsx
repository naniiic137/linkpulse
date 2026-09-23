import { useCountdown } from '../hooks/useCountdown';
import type { RateLimitInfo } from '../api/client';
import { Icon } from './Icon';

interface Props {
  /** Epoch ms at which the client may retry. */
  until: number;
  info: RateLimitInfo;
}

/** Shown when the API answers 429: explains the limit and counts down Retry-After. */
export function RateLimitBanner({ until, info }: Props) {
  const left = useCountdown(until);
  const done = left === 0;
  return (
    <div className={`banner ${done ? 'banner--info' : 'banner--warn'}`} role="alert">
      <Icon name={done ? 'check' : 'clock'} size={18} />
      <div>
        <strong>{done ? 'You can try again now.' : 'Slow down. You hit the rate limit.'}</strong>
        <p>
          {done
            ? 'The rate-limit window has moved on.'
            : `Too many requests in a short time. Try again in ${left} s.`}
          {info.limit !== null && ` Limit: ${info.limit} requests per window.`}
        </p>
      </div>
      {!done && (
        <span className="banner__count" aria-hidden="true">
          {left}s
        </span>
      )}
    </div>
  );
}
