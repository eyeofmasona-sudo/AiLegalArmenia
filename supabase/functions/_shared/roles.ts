export async function hasUserRole(
  supabase: unknown,
  userId: string,
  role: string,
): Promise<boolean> {
  const roleClient = supabase as RoleClient;
  const { data, error } = await roleClient
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", role)
    .maybeSingle();

  if (error) {
    console.warn("[roles] role lookup failed", { userId, role, message: error.message });
    return false;
  }

  return Boolean(data);
}

type RoleClient = {
  from: (table: string) => {
    select: (columns: string) => RoleQueryBuilder;
  };
};

type RoleQueryBuilder = {
  eq: (column: string, value: unknown) => RoleQueryBuilder;
  maybeSingle: () => PromiseLike<{
    data: unknown | null;
    error: { message?: string } | null;
  }>;
};
