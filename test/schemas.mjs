// The tables rulebook-to-postgres would generate for three different projects, with data chosen to
// be awkward: shared addresses, upper-case addresses, people with no role, several roles, an
// inactive admin, a role that is only text, a status kept inverted, grants in their own table.
// Views are plain (not security_invoker), as an older generator leaves them: the seed fixes that.

// 1. The seed's own tables (AppUsers + AppRoles), plus the project's Orders.
export const appUsers = {
  cfg: {}, // the defaults
  sql: `
CREATE TABLE app_roles (app_role_id text PRIMARY KEY, display_name text);
CREATE TABLE app_users (app_user_id text PRIMARY KEY, email_address text NOT NULL, display_name text,
                        app_role text REFERENCES app_roles(app_role_id), is_active boolean);
CREATE TABLE orders (order_id text PRIMARY KEY, title text, owner_email text, amount numeric);
CREATE TABLE settings (setting_id text PRIMARY KEY, value text);
CREATE VIEW vw_app_roles AS SELECT *, display_name AS name FROM app_roles;
CREATE VIEW vw_app_users AS SELECT *, coalesce(display_name, email_address) AS name FROM app_users;
CREATE VIEW vw_orders AS SELECT *, amount * 2 AS double_amount FROM orders;
CREATE VIEW vw_settings AS SELECT * FROM settings;
INSERT INTO app_roles VALUES ('admin', 'Admin'), ('member', 'Member'), ('viewer', 'Viewer');
INSERT INTO app_users VALUES
  ('ann',   'Ann@Example.com',   'Ann Admin',   'admin',  true),
  ('bob',   'bob@example.com',   'Bob Member',  'member', true),
  ('cat',   'cat@example.com',   NULL,          'member', NULL),    -- active unknown: counts as active
  ('dan',   'dan@example.com',   'Dan Gone',    'admin',  false),   -- an inactive admin
  ('eve',   'eve@example.com',   'Eve No Role', NULL,     true),    -- signed in, no role
  ('old-b', 'BOB@example.com',   'Old Bob',     'admin',  false);   -- same address as bob, inactive, admin
INSERT INTO orders VALUES ('o1', 'Ann''s', 'ann@example.com', 10), ('o2', 'Bob''s', 'bob@example.com', 20),
                          ('o3', 'Cat''s', 'cat@example.com', 30);
INSERT INTO settings VALUES ('theme', 'dark');
`,
};

// 2. The editor's Users and roles module (ERBUsers / ERBRoles), mapped instead of adding tables.
export const erbUsers = {
  cfg: { usersTable: 'ERBUsers', userKeyField: 'ERBUserId', emailField: 'EmailAddress', nameField: 'DisplayName',
         activeField: 'IsActive', roleField: 'ERBRole', rolesTable: 'ERBRoles', roleKeyField: 'ERBRoleId', adminRole: 'admin' },
  sql: `
CREATE TABLE erb_roles (erb_role_id text PRIMARY KEY, title text, is_admin_equivalent boolean);
CREATE TABLE erb_users (erb_user_id text PRIMARY KEY, email_address text, display_name text,
                        erb_role text REFERENCES erb_roles(erb_role_id), external_user_id text, is_active boolean);
CREATE TABLE shifts (shift_id text PRIMARY KEY, volunteer_email text, starts_at text);
CREATE VIEW vw_erb_roles AS SELECT * FROM erb_roles;
CREATE VIEW vw_erb_users AS SELECT * FROM erb_users;
CREATE VIEW vw_shifts AS SELECT * FROM shifts;
INSERT INTO erb_roles VALUES ('admin', 'Admin', true), ('coordinator', 'Coordinator', false), ('volunteer', 'Volunteer', false);
INSERT INTO erb_users VALUES
  ('owner@kitchen.org', 'owner@kitchen.org', 'Olive Owner', 'admin', NULL, true),
  ('cora@kitchen.org',  'Cora@Kitchen.org',  'Cora',        'coordinator', NULL, true),
  ('val@kitchen.org',   'val@kitchen.org',   'Val',         'volunteer', NULL, true),
  ('nomail',            NULL,                'No Email',    'volunteer', NULL, true);
INSERT INTO shifts VALUES ('s1', 'val@kitchen.org', '09:00'), ('s2', 'cora@kitchen.org', '10:00');
`,
};

// 3. Members kept active by an inverted flag, roles granted in their own table, a company claim.
export const members = {
  cfg: { usersTable: 'Members', userKeyField: 'MemberId', emailField: 'WorkEmail', nameField: 'FullName',
         activeField: '!IsArchived', roleField: '', rolesTable: '', roleKeyField: '',
         userRolesTable: 'MemberRoles', userRolesUserField: 'Member', userRolesRoleField: 'RoleName',
         adminRole: 'owner', claims: { company: 'CompanyName' }, sessionHours: 1 },
  sql: `
CREATE TABLE members (member_id text PRIMARY KEY, work_email text, full_name text, is_archived boolean, company_name text);
CREATE TABLE member_roles (member_role_id text PRIMARY KEY, member text REFERENCES members(member_id), role_name text);
CREATE TABLE projects (project_id text PRIMARY KEY, company_name text, title text);
CREATE VIEW vw_members AS SELECT * FROM members;
CREATE VIEW vw_member_roles AS SELECT * FROM member_roles;
CREATE VIEW vw_projects AS SELECT * FROM projects;
INSERT INTO members VALUES
  ('m1', 'pat@acme.test',  'Pat Owner',   false, 'Acme'),
  ('m2', 'sam@acme.test',  'Sam Two Hats', NULL, 'Acme'),
  ('m3', 'lee@beta.test',  'Lee Archived', true, 'Beta'),
  ('m4', 'kim@beta.test',  'Kim Plain',   false, 'Beta');
INSERT INTO member_roles VALUES ('r1', 'm1', 'owner'), ('r2', 'm2', 'editor'), ('r3', 'm2', 'reviewer'), ('r4', 'm3', 'owner'), ('r5', 'm2', NULL);
INSERT INTO projects VALUES ('p1', 'Acme', 'Rocket'), ('p2', 'Beta', 'Boat');
`,
  // The project's own rule, in its 04b row ahead of the seed's block: a member sees their company's projects.
  projectPolicies: `
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_projects ON projects FOR ALL USING (company_name = app.claim('company')) WITH CHECK (company_name = app.claim('company'));
`,
};
