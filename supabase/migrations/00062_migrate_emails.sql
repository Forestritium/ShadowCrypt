UPDATE auth.users
SET email = replace(email, '@shadowcrypt.com', '@sylvacrypt.com')
WHERE email LIKE '%@shadowcrypt.com';

UPDATE public.profiles
SET email = replace(email, '@shadowcrypt.com', '@sylvacrypt.com')
WHERE email LIKE '%@shadowcrypt.com';