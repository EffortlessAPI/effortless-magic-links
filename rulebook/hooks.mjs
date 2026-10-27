// --admin you@example.com (repeatable): approved admins to start with. There is no sign-up,
// so beta and production need at least one before anybody can get in.
export function prepare(tables, { values }) {
  const admins = values('--admin').map((e) => e.toLowerCase());
  if (tables.AppUsers) {
    tables.AppUsers.data = admins.map((email) => ({ AppUserId: email, EmailAddress: email, DisplayName: email.split('@')[0], Role: 'admin', IsActive: true }));
  }
  return { notes: admins.length ? [] : ['! no --admin given: nobody can sign in on beta/production until an AppUsers admin row exists'] };
}
