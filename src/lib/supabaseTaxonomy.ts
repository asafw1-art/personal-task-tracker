import type { User } from "@supabase/supabase-js";
import type { TaskPrefix } from "@/lib/tasks";
import { supabase } from "@/lib/supabase";

export type CloudTaxonomy = {
  topics: Record<TaskPrefix, string[]>;
  actions: string[];
};

type TaxonomyRow = {
  item_type: "topic" | "action";
  prefix: TaskPrefix | null;
  name: string;
};

function requireSupabase() {
  if (!supabase) throw new Error("Supabase is not configured");
  return supabase;
}

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, "he"));
}

export async function fetchCloudTaxonomy(): Promise<CloudTaxonomy> {
  const client = requireSupabase();
  const { data, error } = await client
    .from("task_taxonomy_items")
    .select("item_type, prefix, name")
    .order("name", { ascending: true });

  if (error) throw error;

  const rows = (data ?? []) as TaxonomyRow[];
  return {
    topics: {
      P: uniqueSorted(rows.filter((row) => row.item_type === "topic" && row.prefix === "P").map((row) => row.name)),
      W: uniqueSorted(rows.filter((row) => row.item_type === "topic" && row.prefix === "W").map((row) => row.name)),
    },
    actions: uniqueSorted(rows.filter((row) => row.item_type === "action").map((row) => row.name)),
  };
}

export async function replaceCloudTaxonomy(taxonomy: CloudTaxonomy, user: User) {
  const client = requireSupabase();
  const rows = [
    ...taxonomy.topics.P.map((name) => ({ user_id: user.id, item_type: "topic", prefix: "P", name })),
    ...taxonomy.topics.W.map((name) => ({ user_id: user.id, item_type: "topic", prefix: "W", name })),
    ...taxonomy.actions.map((name) => ({ user_id: user.id, item_type: "action", prefix: null, name })),
  ];

  const { error: deleteError } = await client
    .from("task_taxonomy_items")
    .delete()
    .eq("user_id", user.id);

  if (deleteError) throw deleteError;
  if (rows.length === 0) return;

  const { error: insertError } = await client
    .from("task_taxonomy_items")
    .insert(rows);

  if (insertError) throw insertError;
}
