-- VeloExpense 0063_drop_action_token — d62 (13 Oct 2026).
--
-- An approval is decided on the report, signed in, never from a link in an email. The
-- approval email now links to the report and nothing else, so the single-use approve /
-- reject tokens it carried (VX2-8, 0012; on engine tasks since 0061/0062) have no issuer
-- and no reader. The table goes, and its two policies, indexes and foreign keys with it.
--
-- An approve link still sitting in an inbox lands on /approve, which now only opens the
-- approver's queue (app/approve/page.tsx). Nothing in it can decide anything.

DROP TABLE action_token;
