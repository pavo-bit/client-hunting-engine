-- Migration M15: inbox identity is per consumer (Part 1).
--
-- Forward-only repair of M10. Root cause, found by the concurrency tests: the
-- inbox primary key was `event_id` alone, so the SECOND consumer claiming an
-- already-delivered event hit a primary-key conflict. Its insert was silently
-- suppressed and it received `already_seen` for work it had never seen — a
-- second consumer could never be served. Delivery identity is per
-- (consumer, event); the key becomes composite. The existing
-- (consumer_name, outbox_id) uniqueness stays as the ordering key.
alter table p2.event_inbox drop constraint event_inbox_pkey;
alter table p2.event_inbox add primary key (consumer_name, event_id);