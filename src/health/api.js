// ======================================================
// Browser client for Apple Health.
//
// Reads only, and only rollups: the phone writes raw samples through the
// `healthsync` Edge Function, and nothing in the browser ever sees one. Each
// call is a SQL function from 0010_health_api.sql, run with the user's JWT; the
// function itself refuses anyone asking for a user other than themselves.
// ======================================================

import { supabase } from '../supabase.js';

async function rpc(fn, args = {}) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

export const overview = (from, to)               => rpc('health_overview', { p_from: from, p_to: to });
export const series   = (type, from, to)         => rpc('health_series', { p_type: type, p_from: from, p_to: to });
export const intraday = (type, day, minutes = 60) => rpc('health_intraday', { p_type: type, p_day: day, p_bucket_minutes: minutes });
export const sleep    = (from, to)               => rpc('health_sleep', { p_from: from, p_to: to });
export const workouts = (from, to)               => rpc('health_workouts', { p_from: from, p_to: to });
export const catalog  = ()                       => rpc('health_catalog');
