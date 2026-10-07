-- TripOS schema bootstrap — the complete DDL for a fresh database.
--
-- Generated from the live schema with pg_dump (schema-only, no owners,
-- no privileges) and committed so a fresh instance can be created without
-- Prisma's CLI (which needs a binary download this build sandbox cannot
-- reach — see docs/DATABASE.md). Three edits to the raw dump, all stated
-- rather than hidden:
--
--   1. CREATE EXTENSION vector is prepended. The dump omitted it (the
--      extension is installed in the source database, 0.8.0) and every
--      document-embedding column depends on it.
--   2. CREATE SCHEMA public is made IF NOT EXISTS, because a fresh
--      database already has that schema.
--   3. pg_dump's \restrict / \unrestrict guard lines are removed, so the
--      file applies with any psql, not only one at least as new as the
--      client that wrote it.
--
-- Applied by docker-compose (services/db-init) and by CI, and verified in
-- Phase 30 by building a scratch database from this file alone and running
-- the whole test suite against it.
--
-- Order matters: enums, then tables, then indexes and constraints.

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
--
-- PostgreSQL database dump
--


-- Dumped from database version 14.24 (Ubuntu 14.24-0ubuntu0.22.04.1)
-- Dumped by pg_dump version 14.24 (Ubuntu 14.24-0ubuntu0.22.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: ActorType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ActorType" AS ENUM (
    'USER',
    'SYSTEM',
    'AI_AGENT'
);


--
-- Name: ApiHealthStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ApiHealthStatus" AS ENUM (
    'OPERATIONAL',
    'DEGRADED',
    'DOWN'
);


--
-- Name: DocumentStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."DocumentStatus" AS ENUM (
    'UPLOADED',
    'PROCESSING',
    'READY',
    'FAILED'
);


--
-- Name: FlightStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."FlightStatus" AS ENUM (
    'UNKNOWN',
    'SCHEDULED',
    'DELAYED',
    'CANCELLED',
    'LANDED',
    'COMPLETED'
);


--
-- Name: ItineraryItemSource; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ItineraryItemSource" AS ENUM (
    'USER',
    'AI_PLANNER'
);


--
-- Name: ItineraryItemType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ItineraryItemType" AS ENUM (
    'FLIGHT',
    'LODGING',
    'ACTIVITY',
    'TRANSPORT',
    'MEAL',
    'OTHER'
);


--
-- Name: RecommendationStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."RecommendationStatus" AS ENUM (
    'PENDING',
    'ACKNOWLEDGED',
    'DISMISSED'
);


--
-- Name: RiskSeverity; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."RiskSeverity" AS ENUM (
    'LOW',
    'MEDIUM',
    'HIGH',
    'CRITICAL'
);


--
-- Name: Role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."Role" AS ENUM (
    'USER',
    'ADMIN'
);


--
-- Name: TripStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."TripStatus" AS ENUM (
    'PLANNING',
    'UPCOMING',
    'ACTIVE',
    'COMPLETED',
    'CANCELLED'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_health; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_health (
    id text DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    status public."ApiHealthStatus" DEFAULT 'OPERATIONAL'::public."ApiHealthStatus" NOT NULL,
    last_checked_at timestamp(3) without time zone NOT NULL,
    last_success_at timestamp(3) without time zone,
    last_failure_at timestamp(3) without time zone,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id text DEFAULT gen_random_uuid() NOT NULL,
    actor_type public."ActorType" NOT NULL,
    actor_id text,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    metadata jsonb,
    request_id text,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: currency_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.currency_snapshots (
    id text DEFAULT gen_random_uuid() NOT NULL,
    trip_id text NOT NULL,
    base_currency character(3) NOT NULL,
    target_currency character(3) NOT NULL,
    rate numeric(18,8) NOT NULL,
    provider text NOT NULL,
    raw_provider_response jsonb,
    fetched_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: destinations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.destinations (
    id text DEFAULT gen_random_uuid() NOT NULL,
    trip_id text NOT NULL,
    city text NOT NULL,
    country text NOT NULL,
    latitude numeric(9,6),
    longitude numeric(9,6),
    arrival_date timestamp(3) without time zone,
    departure_date timestamp(3) without time zone,
    order_index integer DEFAULT 0 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: document_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_chunks (
    id text DEFAULT gen_random_uuid() NOT NULL,
    trip_document_id text NOT NULL,
    chunk_index integer NOT NULL,
    content text NOT NULL,
    embedding public.vector(1024),
    token_count integer,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: flight_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flight_records (
    id text DEFAULT gen_random_uuid() NOT NULL,
    trip_id text NOT NULL,
    flight_number text NOT NULL,
    airline text NOT NULL,
    departure_airport text NOT NULL,
    arrival_airport text NOT NULL,
    scheduled_departure timestamp(3) without time zone NOT NULL,
    scheduled_arrival timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: flight_status_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flight_status_snapshots (
    id text DEFAULT gen_random_uuid() NOT NULL,
    flight_record_id text NOT NULL,
    status public."FlightStatus" DEFAULT 'UNKNOWN'::public."FlightStatus" NOT NULL,
    actual_departure timestamp(3) without time zone,
    actual_arrival timestamp(3) without time zone,
    delay_minutes integer,
    raw_provider_response jsonb,
    fetched_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: itinerary_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.itinerary_items (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    trip_id text NOT NULL,
    itinerary_day date NOT NULL,
    start_time text,
    end_time text,
    title text NOT NULL,
    item_type public."ItineraryItemType" DEFAULT 'OTHER'::public."ItineraryItemType" NOT NULL,
    location text,
    destination_id text,
    notes text,
    estimated_cost numeric(12,2),
    currency character(3),
    source public."ItineraryItemSource" DEFAULT 'USER'::public."ItineraryItemSource" NOT NULL,
    plan_run_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT itinerary_items_cost_currency_together CHECK (((estimated_cost IS NULL) = (currency IS NULL))),
    CONSTRAINT itinerary_items_cost_non_negative CHECK (((estimated_cost IS NULL) OR (estimated_cost >= (0)::numeric))),
    CONSTRAINT itinerary_items_time_format CHECK ((((start_time IS NULL) OR (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text)) AND ((end_time IS NULL) OR (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text))))
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id text DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    trip_event_id text,
    title text NOT NULL,
    body text NOT NULL,
    read_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: recommendations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recommendations (
    id text DEFAULT gen_random_uuid() NOT NULL,
    trip_id text NOT NULL,
    risk_assessment_id text,
    decision text NOT NULL,
    evidence jsonb NOT NULL,
    reasoning_summary text NOT NULL,
    recommendation_text text NOT NULL,
    confidence numeric(3,2) NOT NULL,
    status public."RecommendationStatus" DEFAULT 'PENDING'::public."RecommendationStatus" NOT NULL,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: risk_assessments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.risk_assessments (
    id text DEFAULT gen_random_uuid() NOT NULL,
    trip_id text NOT NULL,
    risk_score integer NOT NULL,
    severity public."RiskSeverity" NOT NULL,
    factors jsonb NOT NULL,
    evidence jsonb NOT NULL,
    confidence numeric(3,2) NOT NULL,
    generated_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id text DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    revoked_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: travelers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.travelers (
    id text DEFAULT gen_random_uuid() NOT NULL,
    trip_id text NOT NULL,
    full_name text NOT NULL,
    date_of_birth timestamp(3) without time zone,
    passport_number text,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: trip_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trip_documents (
    id text DEFAULT gen_random_uuid() NOT NULL,
    trip_id text NOT NULL,
    uploaded_by text NOT NULL,
    original_filename text NOT NULL,
    storage_key text NOT NULL,
    mime_type text NOT NULL,
    size_bytes integer NOT NULL,
    status public."DocumentStatus" DEFAULT 'UPLOADED'::public."DocumentStatus" NOT NULL,
    failure_reason text,
    extracted_metadata jsonb,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    extracted_text text
);


--
-- Name: trip_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trip_events (
    id text DEFAULT gen_random_uuid() NOT NULL,
    trip_id text NOT NULL,
    event_type text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    metadata jsonb,
    dedupe_key text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: trip_watches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trip_watches (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    trip_id text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    interval_minutes integer DEFAULT 60 NOT NULL,
    alert_min_severity public."RiskSeverity" DEFAULT 'MEDIUM'::public."RiskSeverity" NOT NULL,
    last_run_at timestamp with time zone,
    last_error text,
    next_run_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trip_watches_interval_bounds CHECK (((interval_minutes >= 5) AND (interval_minutes <= 1440)))
);


--
-- Name: trips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trips (
    id text DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    title text NOT NULL,
    status public."TripStatus" DEFAULT 'PLANNING'::public."TripStatus" NOT NULL,
    start_date timestamp(3) without time zone,
    end_date timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    budget_amount numeric(12,2),
    budget_currency character(3),
    CONSTRAINT trips_budget_pair_check CHECK ((((budget_amount IS NULL) = (budget_currency IS NULL)) AND ((budget_amount IS NULL) OR (budget_amount > (0)::numeric))))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id text DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    name text NOT NULL,
    role public."Role" DEFAULT 'USER'::public."Role" NOT NULL,
    email_verified_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: weather_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.weather_snapshots (
    id text DEFAULT gen_random_uuid() NOT NULL,
    destination_id text NOT NULL,
    temperature_celsius numeric(5,2) NOT NULL,
    condition text NOT NULL,
    wind_speed_kph numeric(5,2),
    precipitation_mm numeric(6,2),
    raw_provider_response jsonb,
    fetched_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: api_health api_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_health
    ADD CONSTRAINT api_health_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: currency_snapshots currency_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.currency_snapshots
    ADD CONSTRAINT currency_snapshots_pkey PRIMARY KEY (id);


--
-- Name: destinations destinations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.destinations
    ADD CONSTRAINT destinations_pkey PRIMARY KEY (id);


--
-- Name: document_chunks document_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_chunks
    ADD CONSTRAINT document_chunks_pkey PRIMARY KEY (id);


--
-- Name: flight_records flight_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flight_records
    ADD CONSTRAINT flight_records_pkey PRIMARY KEY (id);


--
-- Name: flight_status_snapshots flight_status_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flight_status_snapshots
    ADD CONSTRAINT flight_status_snapshots_pkey PRIMARY KEY (id);


--
-- Name: itinerary_items itinerary_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.itinerary_items
    ADD CONSTRAINT itinerary_items_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: recommendations recommendations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recommendations
    ADD CONSTRAINT recommendations_pkey PRIMARY KEY (id);


--
-- Name: risk_assessments risk_assessments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.risk_assessments
    ADD CONSTRAINT risk_assessments_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: travelers travelers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.travelers
    ADD CONSTRAINT travelers_pkey PRIMARY KEY (id);


--
-- Name: trip_documents trip_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_documents
    ADD CONSTRAINT trip_documents_pkey PRIMARY KEY (id);


--
-- Name: trip_events trip_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_events
    ADD CONSTRAINT trip_events_pkey PRIMARY KEY (id);


--
-- Name: trip_watches trip_watches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_watches
    ADD CONSTRAINT trip_watches_pkey PRIMARY KEY (id);


--
-- Name: trip_watches trip_watches_trip_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_watches
    ADD CONSTRAINT trip_watches_trip_id_key UNIQUE (trip_id);


--
-- Name: trips trips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: weather_snapshots weather_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weather_snapshots
    ADD CONSTRAINT weather_snapshots_pkey PRIMARY KEY (id);


--
-- Name: api_health_provider_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX api_health_provider_key ON public.api_health USING btree (provider);


--
-- Name: audit_logs_entity_type_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_entity_type_entity_id_idx ON public.audit_logs USING btree (entity_type, entity_id);


--
-- Name: audit_logs_request_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_request_id_idx ON public.audit_logs USING btree (request_id);


--
-- Name: currency_snapshots_trip_id_fetched_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX currency_snapshots_trip_id_fetched_at_idx ON public.currency_snapshots USING btree (trip_id, fetched_at);


--
-- Name: destinations_trip_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX destinations_trip_id_idx ON public.destinations USING btree (trip_id);


--
-- Name: document_chunks_embedding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_chunks_embedding_idx ON public.document_chunks USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: document_chunks_trip_document_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_chunks_trip_document_id_idx ON public.document_chunks USING btree (trip_document_id);


--
-- Name: flight_records_trip_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX flight_records_trip_id_idx ON public.flight_records USING btree (trip_id);


--
-- Name: flight_status_snapshots_flight_record_id_fetched_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX flight_status_snapshots_flight_record_id_fetched_at_idx ON public.flight_status_snapshots USING btree (flight_record_id, fetched_at);


--
-- Name: itinerary_items_trip_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX itinerary_items_trip_day_idx ON public.itinerary_items USING btree (trip_id, itinerary_day, start_time);


--
-- Name: notifications_user_id_read_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_id_read_at_idx ON public.notifications USING btree (user_id, read_at);


--
-- Name: recommendations_risk_assessment_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recommendations_risk_assessment_id_idx ON public.recommendations USING btree (risk_assessment_id);


--
-- Name: recommendations_trip_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recommendations_trip_id_idx ON public.recommendations USING btree (trip_id);


--
-- Name: risk_assessments_trip_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX risk_assessments_trip_id_idx ON public.risk_assessments USING btree (trip_id);


--
-- Name: sessions_token_hash_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sessions_token_hash_key ON public.sessions USING btree (token_hash);


--
-- Name: sessions_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_id_idx ON public.sessions USING btree (user_id);


--
-- Name: travelers_trip_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX travelers_trip_id_idx ON public.travelers USING btree (trip_id);


--
-- Name: trip_documents_trip_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trip_documents_trip_id_idx ON public.trip_documents USING btree (trip_id);


--
-- Name: trip_events_dedupe_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX trip_events_dedupe_key_key ON public.trip_events USING btree (dedupe_key);


--
-- Name: trip_events_trip_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trip_events_trip_id_created_at_idx ON public.trip_events USING btree (trip_id, created_at);


--
-- Name: trip_watches_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trip_watches_due_idx ON public.trip_watches USING btree (enabled, next_run_at);


--
-- Name: trips_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trips_user_id_idx ON public.trips USING btree (user_id);


--
-- Name: users_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email);


--
-- Name: weather_snapshots_destination_id_fetched_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX weather_snapshots_destination_id_fetched_at_idx ON public.weather_snapshots USING btree (destination_id, fetched_at);


--
-- Name: currency_snapshots currency_snapshots_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.currency_snapshots
    ADD CONSTRAINT currency_snapshots_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: destinations destinations_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.destinations
    ADD CONSTRAINT destinations_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: document_chunks document_chunks_trip_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_chunks
    ADD CONSTRAINT document_chunks_trip_document_id_fkey FOREIGN KEY (trip_document_id) REFERENCES public.trip_documents(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: flight_records flight_records_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flight_records
    ADD CONSTRAINT flight_records_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: flight_status_snapshots flight_status_snapshots_flight_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flight_status_snapshots
    ADD CONSTRAINT flight_status_snapshots_flight_record_id_fkey FOREIGN KEY (flight_record_id) REFERENCES public.flight_records(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: itinerary_items itinerary_items_destination_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.itinerary_items
    ADD CONSTRAINT itinerary_items_destination_id_fkey FOREIGN KEY (destination_id) REFERENCES public.destinations(id) ON DELETE SET NULL;


--
-- Name: itinerary_items itinerary_items_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.itinerary_items
    ADD CONSTRAINT itinerary_items_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_trip_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_trip_event_id_fkey FOREIGN KEY (trip_event_id) REFERENCES public.trip_events(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: recommendations recommendations_risk_assessment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recommendations
    ADD CONSTRAINT recommendations_risk_assessment_id_fkey FOREIGN KEY (risk_assessment_id) REFERENCES public.risk_assessments(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: recommendations recommendations_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recommendations
    ADD CONSTRAINT recommendations_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: risk_assessments risk_assessments_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.risk_assessments
    ADD CONSTRAINT risk_assessments_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: travelers travelers_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.travelers
    ADD CONSTRAINT travelers_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: trip_documents trip_documents_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_documents
    ADD CONSTRAINT trip_documents_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: trip_documents trip_documents_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_documents
    ADD CONSTRAINT trip_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: trip_events trip_events_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_events
    ADD CONSTRAINT trip_events_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: trip_watches trip_watches_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_watches
    ADD CONSTRAINT trip_watches_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE CASCADE;


--
-- Name: trips trips_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: weather_snapshots weather_snapshots_destination_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weather_snapshots
    ADD CONSTRAINT weather_snapshots_destination_id_fkey FOREIGN KEY (destination_id) REFERENCES public.destinations(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


