import Link from 'next/link';
import { Card, Lede, Shell, Title } from '@/app/pre-auth';

/** What a closed deployment shows at /signup and /signup/verify. */
export function SignupClosed() {
  return (
    <Shell>
      <Card>
        <Title>Sign-up is by invitation</Title>
        <Lede>
          New VeloExpense organizations are set up for you rather than created here. If your
          organization already uses VeloExpense, ask its administrator to invite you.
        </Lede>
        <p className="text-sm text-muted-foreground">
          Already have an organization?{' '}
          <Link className="underline underline-offset-4" href="/login">
            Sign in
          </Link>
        </p>
      </Card>
    </Shell>
  );
}
