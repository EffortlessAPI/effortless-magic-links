// Rulebooks the agent meets in real projects, ambiguous on purpose. Each says what a careful
// mapping is, and what should make the agent stop and ask.
const t = (Description, schema, data = []) => ({ Description, schema, data });
const raw = (name, datatype = 'string', extra = {}) => ({ name, datatype, type: 'raw', ...extra });
const rel = (name, RelatedTo) => ({ name, datatype: 'string', type: 'relationship', RelatedTo });
const calc = (name, formula, datatype = 'string') => ({ name, datatype, type: 'calculated', formula });

// The starter a new project begins with: no people at all.
export const starter = () => ({
  $schema: 'https://effortlessapi.com/rulebook.schema.json', Name: 'Hello', Description: 'Starter',
  HelloWhos: t('Who to greet', [raw('HelloWhoId'), raw('Greeting'), calc('Name', '={{Greeting}}')], [{ HelloWhoId: 'world', Greeting: 'Hello, world' }]),
});

// A community kitchen: volunteers sign in; neighbours are served and have emails too.
export const kitchen = () => ({
  Name: 'Kitchen', Description: 'Common Table',
  Volunteers: t('People who staff shifts', [raw('VolunteerId'), raw('FullName'), raw('EmailAddress'), raw('Role'), raw('IsActive', 'boolean'), calc('Name', '={{FullName}}')], [
    { VolunteerId: 'v1', FullName: 'Olive Owner', EmailAddress: 'olive@kitchen.test', Role: 'admin', IsActive: true },
    { VolunteerId: 'v2', FullName: 'Cora Coord', EmailAddress: 'CORA@kitchen.test', Role: 'coordinator,driver', IsActive: true },
    { VolunteerId: 'v3', FullName: 'Val Vol', EmailAddress: 'val@kitchen.test', Role: 'volunteer', IsActive: false },
    { VolunteerId: 'v4', FullName: 'Cora Again', EmailAddress: 'cora@kitchen.test', Role: 'volunteer', IsActive: false },
    { VolunteerId: 'v5', FullName: 'No Mail', EmailAddress: null, Role: 'volunteer', IsActive: true },
  ]),
  Neighbors: t('Households served', [raw('NeighborId'), raw('HouseholdName'), raw('ContactEmail'), raw('Allergies')], [
    { NeighborId: 'n1', HouseholdName: 'Rivera', ContactEmail: 'rivera@home.test', Allergies: 'nuts' },
  ]),
  Shifts: t('Shifts', [raw('ShiftId'), rel('Volunteer', 'Volunteers'), raw('StartsAt')], []),
});

// The editor's Users and roles module is on, and the domain has Members with emails too.
export const erbOn = () => ({
  Name: 'Guild', Description: 'A guild',
  ERBRoles: t('Roles', [raw('ERBRoleId'), raw('Title'), raw('DefaultCRUD'), raw('IsAdminEquivalent', 'boolean')], [
    { ERBRoleId: 'admin', Title: 'Administrator', DefaultCRUD: 'CRUD', IsAdminEquivalent: true },
    { ERBRoleId: 'artisan', Title: 'Artisan', DefaultCRUD: 'R', IsAdminEquivalent: false },
  ]),
  ERBUsers: t('Users', [raw('ERBUserId'), raw('EmailAddress'), raw('DisplayName'), rel('ERBRole', 'ERBRoles'), raw('ExternalUserId'), raw('IsActive', 'boolean')], [
    { ERBUserId: 'gm@guild.test', EmailAddress: 'gm@guild.test', DisplayName: 'Guild Master', ERBRole: 'admin', IsActive: true },
  ]),
  ERBRoleTablePermissions: t('Overrides', [raw('ERBRoleTablePermissionId'), rel('ERBRole', 'ERBRoles'), raw('CRUD')], []),
  Members: t('Guild members', [raw('MemberId'), raw('Email'), raw('Craft')], [{ MemberId: 'm1', Email: 'smith@guild.test', Craft: 'iron' }]),
});

// A SaaS: members archived rather than deactivated, roles granted in their own table, two email
// fields, a Status text field, and the project already has SQL of its own in both rows.
export const saas = () => ({
  Name: 'Acme', Description: 'Acme',
  Companies: t('Customers', [raw('CompanyId'), raw('CompanyName'), raw('BillingEmail')], [{ CompanyId: 'c1', CompanyName: 'Acme', BillingEmail: 'billing@acme.test' }]),
  Members: t('People at customers', [raw('MemberId'), raw('FullName'), raw('WorkEmail'), raw('PersonalEmail'), raw('Status'), raw('IsArchived', 'boolean'), rel('Company', 'Companies')], [
    { MemberId: 'm1', FullName: 'Pat', WorkEmail: 'pat@acme.test', PersonalEmail: 'pat@home.test', Status: 'Active', IsArchived: false, Company: 'c1' },
    { MemberId: 'm2', FullName: 'Lee', WorkEmail: 'lee@acme.test', PersonalEmail: null, Status: 'Left', IsArchived: true, Company: 'c1' },
  ]),
  Permissions: t('What a grant allows', [raw('PermissionId'), raw('Title')], [{ PermissionId: 'owner', Title: 'Owner' }, { PermissionId: 'editor', Title: 'Editor' }]),
  MemberPermissions: t('Grants', [raw('MemberPermissionId'), rel('Member', 'Members'), rel('Permission', 'Permissions')], [
    { MemberPermissionId: 'g1', Member: 'm1', Permission: 'editor' },
  ]),
  ERBCustomizations: t('SQL', [raw('ERBCustomizationId'), raw('Name'), raw('CustomizationType'), raw('SQLCode'), raw('SQLTarget')], [
    { ERBCustomizationId: 'f', Name: '02b-customize-functions.sql', CustomizationType: 'Custom', SQLCode: "CREATE OR REPLACE FUNCTION public.company_of_me() RETURNS text LANGUAGE sql STABLE AS $$ SELECT app.claim('company') $$;", SQLTarget: 'Postgres' },
    { ERBCustomizationId: 'p', Name: '04b-customize-policies.sql', CustomizationType: 'Custom', SQLCode: 'CREATE POLICY own_company ON companies FOR ALL USING (company_id = public.company_of_me());', SQLTarget: '' },
    { ERBCustomizationId: 'o', Name: 'calc_members_name', CustomizationType: 'FunctionOverride', SQLCode: 'CREATE OR REPLACE FUNCTION calc_members_name() ...', SQLTarget: '' },
  ]),
});

// A shop: Customers carry a role text AND a grants table names roles too. Which is the truth?
export const shop = () => ({
  Name: 'Shop', Description: 'Shop',
  Customers: t('Buyers', [raw('CustomerId'), raw('EmailAddress'), raw('UserRole'), raw('IsDisabled', 'boolean')], [
    { CustomerId: 'u1', EmailAddress: 'a@shop.test', UserRole: 'admin', IsDisabled: false },
  ]),
  StaffAccounts: t('Back office', [raw('StaffAccountId'), raw('LoginEmail'), raw('Enabled', 'boolean')], [
    { StaffAccountId: 's1', LoginEmail: 'boss@shop.test', Enabled: true },
  ]),
  CustomerRoles: t('Grants', [raw('CustomerRoleId'), rel('Customer', 'Customers'), raw('Role')], [{ CustomerRoleId: 'r1', Customer: 'u1', Role: 'buyer' }]),
});
