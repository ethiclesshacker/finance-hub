// ======================================================
// Browser client for Apple Health.
//
// Reads only, and only rollups: the phone writes raw samples through the
// `healthsync` Edge Function, and nothing in the browser ever sees one. Each
// call is a SQL function from 0010_health_api.sql, run with the user's JWT; the
// function itself refuses anyone asking for a user other than themselves.
// ======================================================

import { rpc } from '../rpc.js';

export const overview = (from, to)               => rpc('health_overview', { p_from: from, p_to: to });
export const intraday = (type, day, minutes = 60) => rpc('health_intraday', { p_type: type, p_day: day, p_bucket_minutes: minutes });
export const sleep    = (from, to)               => rpc('health_sleep', { p_from: from, p_to: to });
export const catalog  = ()                       => rpc('health_catalog');

// The joined view: the same days with money and food alongside the body, and
// the Watch's workouts merged with anything told to Hermes (0011_life_api.sql).
export const days     = (from, to)               => rpc('life_days', { p_from: from, p_to: to });
export const activity = (from, to)               => rpc('life_activity', { p_from: from, p_to: to });
