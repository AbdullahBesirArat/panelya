const path = require('path');
const swaggerJsdoc = require('swagger-jsdoc');

const activeServer = process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 3000}`;

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Panelya API',
      version: '2.0.0',
      description: 'Multi-tenant SaaS operations platform API. JWT Bearer token ile kimlik dogrulama yapilir.',
      'x-panelya-release': 'content-analytics-2026-04-18-r3',
    },
    servers: [
      {
        url: activeServer.replace(/\/$/, ''),
        description: 'Active server',
      },
    ],
    tags: [
      { name: 'Health', description: 'Servis saglik kontrolleri' },
      { name: 'Auth', description: 'Workspace auth ve session yonetimi' },
      { name: 'Products', description: 'Tenant bazli katalog ve stok yonetimi' },
      { name: 'Categories', description: 'Tenant bazli kategori yonetimi' },
      { name: 'Orders', description: 'Siparis ve durum akislari' },
      { name: 'Customers', description: 'Musteri listesi ve harcama ozeti' },
      { name: 'Content', description: 'Tenant bazli vitrin slaytlari ve kampanyalar' },
      { name: 'Organizations', description: 'Workspace ve dashboard ozeti' },
      { name: 'Payment', description: 'Odeme baslatma ve callback akislari' },
      {
        name: 'External API',
        description:
          'A29 versiyonlanmis dis API (/v1). Oturum degil, API anahtari ile kimlik dogrulanir: '
          + 'Authorization: Bearer pk_<prefix>.<secret>. Anahtar yalnizca bu baslikta kabul edilir; '
          + 'query string ile gonderilen anahtar 400 API_KEY_IN_QUERY ile reddedilir. '
          + 'Islem yapan tenant anahtardan cozulur, istekten degil. '
          + 'Durum degistiren POST istekleri Idempotency-Key basligi ister.',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
        // A29. Presented the same way as the session bearer but it is NOT a JWT and NOT a
        // session: it carries scopes, not a role, and it can never satisfy an admin route.
        apiKeyAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'pk_<prefix>.<secret>',
          description:
            'A29 dis API anahtari. Yalnizca Authorization basliginda kabul edilir. '
            + 'Gizli deger yalnizca olusturma/dondurme yanitinda bir kez gosterilir ve '
            + 'sunucuda yalnizca sha256 ozeti saklanir.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'Oturum gerekli' },
            requestId: { type: 'string', example: 'req_abc123' },
          },
        },
        ExternalApiError: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                // Machine-readable and stable. Clients branch on this, never on `message`.
                code: { type: 'string', example: 'API_SCOPE_FORBIDDEN' },
                message: { type: 'string', example: 'Bu islem icin products:write yetkisi gerekli' },
                // The same value as the X-Request-Id response header, for correlating a
                // report with our logs. Never a stack trace and never a SQL message.
                request_id: { type: 'string', example: 'req_abc123' },
                fields: { type: 'object', nullable: true },
              },
            },
          },
        },
        Organization: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            name: { type: 'string', example: 'Panelya' },
            slug: { type: 'string', example: 'panelya' },
            plan: { type: 'string', example: 'growth' },
            status: { type: 'string', example: 'active' },
            role: { type: 'string', example: 'owner' },
          },
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            email: { type: 'string', format: 'email', example: 'demo@panelya.dev' },
            name: { type: 'string', example: 'Panelya Owner' },
          },
        },
        Session: {
          type: 'object',
          properties: {
            accessToken: { type: 'string' },
            refreshToken: { type: 'string' },
            user: { $ref: '#/components/schemas/User' },
            currentOrganization: { $ref: '#/components/schemas/Organization' },
            role: { type: 'string', example: 'owner' },
            organizations: {
              type: 'array',
              items: { $ref: '#/components/schemas/Organization' },
            },
          },
        },
        Category: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            name: { type: 'string', example: 'Fulfillment' },
            slug: { type: 'string', example: 'fulfillment' },
          },
        },
        Product: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            name: { type: 'string', example: 'Inventory Control Pack' },
            category_id: { type: 'integer', nullable: true, example: 2 },
            category_name: { type: 'string', nullable: true, example: 'Fulfillment' },
            price: { type: 'string', example: '3290.00' },
            sale_price: { type: 'string', nullable: true, example: null },
            stock: { type: 'integer', example: 4 },
            status: { type: 'string', enum: ['active', 'draft', 'out'], example: 'active' },
            colors: { type: 'array', items: { type: 'string' } },
            images: { type: 'array', items: { type: 'string' } },
            tags: { type: 'string', example: 'inventory,warehouse,ops' },
            emoji: { type: 'string', example: 'IC' },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        Customer: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            name: { type: 'string', example: 'Northstar Labs' },
            email: { type: 'string', format: 'email', example: 'ops@northstarlabs.co' },
            phone: { type: 'string', example: '+90 212 555 0101' },
            address: { type: 'string', example: 'Maslak, Istanbul' },
            orders: { type: 'integer', example: 4 },
            total: { type: 'string', example: '12950.00' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Slide: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            organization_id: { type: 'string', format: 'uuid' },
            tag: { type: 'string', example: 'Panelya Operations' },
            title: { type: 'string', example: 'Panelya vitrin akisi' },
            sub: { type: 'string', example: 'Siparis, stok ve kampanya yonetimi.' },
            btn: { type: 'string', example: 'Katalogu ac' },
            image_url: { type: 'string', example: 'https://images.unsplash.com/photo.jpg' },
            active: { type: 'boolean', example: true },
            sort_order: { type: 'integer', example: 1 },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        Campaign: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            organization_id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'Showcase Launch' },
            type: { type: 'string', example: 'percentage' },
            value: { type: 'string', example: '15.00' },
            end_date: { type: 'string', format: 'date', nullable: true },
            active: { type: 'boolean', example: true },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        Order: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            order_code: { type: 'string', example: '#2401' },
            customer_id: { type: 'integer', nullable: true, example: 1 },
            customer: { type: 'string', nullable: true, example: 'Northstar Labs' },
            total: { type: 'string', example: '3789.00' },
            status: {
              type: 'string',
              enum: ['new', 'payment_pending', 'processing', 'shipped', 'delivered', 'cancelled', 'paid'],
              example: 'paid',
            },
            items: { type: 'string', example: 'Growth Operations Starter x1' },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        OrganizationSummary: {
          type: 'object',
          properties: {
            organization: { $ref: '#/components/schemas/Organization' },
            metrics: { type: 'object' },
            recentOrders: {
              type: 'array',
              items: { $ref: '#/components/schemas/Order' },
            },
            lowStockProducts: {
              type: 'array',
              items: { $ref: '#/components/schemas/Product' },
            },
            recentActivity: {
              type: 'array',
              items: { type: 'object' },
            },
            orderStatusBreakdown: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  status: { type: 'string' },
                  count: { type: 'integer' },
                },
              },
            },
            topCustomers: {
              type: 'array',
              items: { $ref: '#/components/schemas/Customer' },
            },
            subscription: {
              type: 'object',
              nullable: true,
            },
          },
        },
        PaymentInitializeResponse: {
          type: 'object',
          properties: {
            provider: { type: 'string', example: 'mock' },
            order: { $ref: '#/components/schemas/Order' },
            orderCode: { type: 'string', example: '#2401' },
            paymentPageUrl: { type: 'string', nullable: true },
            failureUrl: { type: 'string' },
          },
        },
      },
      responses: {
        Unauthorized: {
          description: 'Oturum gerekli veya token gecersiz',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        Forbidden: {
          description: 'Bu islem icin yetki yok',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        NotFound: {
          description: 'Kayit bulunamadi',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        ValidationError: {
          description: 'Gecersiz istek',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        // The external contract has ONE error shape. It is intentionally different from the
        // internal `Error` above: an integration written against /v1 parses `error.code`,
        // and that has to stay stable across releases.
        ExternalError: {
          description: 'Dis API hata sozlesmesi',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ExternalApiError' },
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: [path.join(__dirname, 'routes/*.js'), path.join(__dirname, 'server.js')],
};

module.exports = swaggerJsdoc(options);
