-- Custom SQL migration (drizzle-kit generate --custom). activity_log partition maintenance (M1-9).
-- diletta_app can't run DDL, so the daily Cron reaches the owner's rights only through these two SECURITY DEFINER
-- functions, owned by the role that runs migrations (the owner of activity_log). Each does one fixed thing:
-- create_activity_log_partition creates one monthly partition, for a UTC month from the current one up to 12 ahead,
-- named activity_log_y<YYYY>m<MM> like the partitions *_partition_activity_log created; activity_log_default_has_rows
-- says whether any row has landed in the DEFAULT partition, without returning a row (the app has no grant on
-- partitions). EXECUTE goes to diletta_app only, never PUBLIC.
-- Fixed search_path (no temp schema, so no shadowing), TimeZone UTC (month bounds and arithmetic are UTC whatever
-- the caller's session says), and a lock_timeout: CREATE … PARTITION OF locks activity_log, so a long-running query
-- holding it makes the create fail fast and retry the next day instead of queueing every activity_log write.
-- A transaction-scoped advisory lock serializes concurrent runs. New partitions inherit the parent's indexes and,
-- like every activity_log_* partition, get no grants.
CREATE FUNCTION "create_activity_log_partition"("p_month_start" timestamptz)
RETURNS TABLE ("partition_name" text, "was_created" boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET timezone = 'UTC'
SET lock_timeout = '5s'
AS $$
DECLARE
	v_current_month timestamptz := date_trunc('month', now());
	v_name text;
	v_partition regclass;
BEGIN
	IF p_month_start IS NULL OR p_month_start <> date_trunc('month', p_month_start) THEN
		RAISE EXCEPTION 'p_month_start must be the first instant of a UTC month' USING ERRCODE = '22023';
	END IF;
	IF p_month_start < v_current_month OR p_month_start > v_current_month + interval '12 months' THEN
		RAISE EXCEPTION 'p_month_start must be between the current UTC month and 12 months ahead' USING ERRCODE = '22023';
	END IF;

	PERFORM pg_advisory_xact_lock(hashtext('create_activity_log_partition'));

	v_name := 'activity_log_' || to_char(p_month_start, '"y"YYYY"m"MM');
	v_partition := to_regclass(format('public.%I', v_name));
	IF v_partition IS NOT NULL THEN
		IF NOT EXISTS (
			SELECT FROM pg_inherits
			WHERE inhrelid = v_partition AND inhparent = 'public.activity_log'::regclass
		) THEN
			RAISE EXCEPTION '% exists but is not a partition of activity_log', v_name USING ERRCODE = '42P07';
		END IF;
		RETURN QUERY SELECT v_name, false;
		RETURN;
	END IF;

	EXECUTE format(
		'CREATE TABLE public.%I PARTITION OF public.activity_log FOR VALUES FROM (%L) TO (%L)',
		v_name,
		p_month_start,
		p_month_start + interval '1 month'
	);
	RETURN QUERY SELECT v_name, true;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "activity_log_default_has_rows"()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
	SELECT EXISTS (SELECT FROM public.activity_log_default);
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "create_activity_log_partition"(timestamptz) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "activity_log_default_has_rows"() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "create_activity_log_partition"(timestamptz) TO diletta_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "activity_log_default_has_rows"() TO diletta_app;
