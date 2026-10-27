-- A miniature of what rulebook-to-postgres generates: base tables, vw_* views, the users table.
CREATE TABLE app_users (app_user_id text PRIMARY KEY, email_address text, display_name text, role text, is_active boolean);
CREATE VIEW vw_app_users AS SELECT * FROM app_users;      -- NOT security_invoker: 20-rls.sql must fix that
CREATE TABLE things (id int PRIMARY KEY, title text, owner_email text);
CREATE VIEW vw_things AS SELECT * FROM things;
INSERT INTO things VALUES (1,'one','ann@example.com'),(2,'two','bob@example.com');
INSERT INTO app_users VALUES ('ann@example.com','ann@example.com','Ann','admin',true),
                             ('bob@example.com','bob@example.com','Bob','member',true),
                             ('cy@example.com','cy@example.com','Cy','member',false);
