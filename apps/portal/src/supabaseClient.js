import { createClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const publishableKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim();

let client = null;
let configError = null;

if (url && publishableKey) {
  try {
    client = createClient(url, publishableKey);
  } catch (e) {
    configError = e.message;
  }
}

export const supabase = client;
export const supabaseConfigured = Boolean(client);
export const supabaseError = configError;