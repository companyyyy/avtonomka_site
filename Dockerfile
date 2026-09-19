FROM httpd:2.4-alpine

# Enable mod_rewrite and allow .htaccess overrides so the site's
# existing .htaccess redirects/rules work as they do on the current host.
RUN sed -i \
    -e 's/^#\(LoadModule rewrite_module .*\)/\1/' \
    -e 's/AllowOverride None/AllowOverride All/' \
    conf/httpd.conf

COPY . /usr/local/apache2/htdocs/
