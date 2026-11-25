/* Business platform admin — ERP Home: what "ERP" means here and every ERP module in one place,
   grouped by business area, each with where it sits in the menu. Only the modules the person's role
   can open are listed. Text via textContent only. */
(function () {
  'use strict';
  var E = window.ERP, el = E.el, has = E.has;

  // [view id, label, permission, menu place, what it is for]
  var AREAS = [
    ['Selling', [
      ['salesdesk', 'Sales Desk', 'sales.reports.view', 'Sales & Orders', 'Orders taken by salesmen and the office, codes sent to retailers, cash waiting for confirmation.'],
      ['salesmen', 'Salesmen', 'sales.reports.view', 'Sales & Orders', 'Your field sales team: beats, retailers, monthly targets, visits and collections.'],
      ['events', 'Events & Counter Sales', 'events.view', 'Sales & Orders', 'Stalls and events: stock issued, counter sales and invoices, returns.'],
      ['locations', 'Field & Event Locations', 'locations.view', 'Sales & Orders', 'Where field staff checked in, and attendance.'],
      ['customers', 'All Customers', 'customers.view', 'Customers', 'One record per customer across the shop, events, field sales and trade accounts.'],
      ['network', 'Distribution Network', 'network.map.view', 'Business Accounts', 'Distributors, their territories and the retailers each one serves.'],
    ]],
    ['Products & prices', [
      ['products', 'Product Master', 'catalog.products.view', 'Products & Catalogue', 'Every product the business sells or buys, with HSN, GST and pack details.'],
      ['pricing', 'Price Lists', 'catalog.pricing.view', 'Products & Catalogue', 'Price lists for retailers and distributors, published with approval.'],
    ]],
    ['Stock', [
      ['stock', 'Stock & Batches', 'inventory.view', 'Inventory', 'Stock in every warehouse, batches and expiry, transfers, counts and adjustments.'],
      ['shopstock', 'Online Shop Stock', 'shop_stock.view', 'Inventory', 'How the online shop\'s stock lines up with the business stock.'],
      ['recalls', 'Recalls', 'recalls.view', 'Inventory', 'Pull back a batch: who received it, what came back.'],
    ]],
    ['Buying & making', [
      ['vendors', 'Manufacturers & Suppliers', 'vendors.view', 'Procurement & Suppliers', 'Suppliers, their documents, products and prices.'],
      ['purchasing', 'Purchasing', 'procurement.pr.view', 'Procurement & Suppliers', 'Requisitions, quotations (RFQs) and purchase orders.'],
      ['receiving', 'Goods Receipt', 'warehouse.grn.create', 'Procurement & Suppliers', 'Receive supplier deliveries into stock (GRN).'],
      ['manufacturers', 'Manufacturers', 'manufacturing.view', 'Manufacturing & Quality', 'Contract manufacturers and their facilities.'],
      ['manufacturing', 'Manufacturing Orders', 'manufacturing.view', 'Manufacturing & Quality', 'Production runs, materials issued and output.'],
      ['quality', 'Batch Quality & Release', 'manufacturing.view', 'Manufacturing & Quality', 'Quality checks before a batch can be sold.'],
      ['boms', 'Bills of Materials', 'manufacturing.view', 'Manufacturing & Quality', 'What goes into each product.'],
    ]],
    ['Delivery', [
      ['deliveryhub', 'Delivery Dashboard', 'deliveries.view', 'Delivery', 'Shipments by status, late ones, today\'s deliveries and each driver\'s workload.'],
      ['deliveries', 'Trade Deliveries', 'deliveries.view', 'Delivery', 'Every trade shipment: dispatch, challan, proof of delivery.'],
      ['deliverystaff', 'Delivery Staff', 'deliveries.manage', 'Delivery', 'The delivery team and what is assigned to each person.'],
    ]],
    ['Money', [
      ['finance', 'Business Finance', 'finance.reports.view', 'Finance & Reports', 'Money owed to you (ageing), bank lines and distributor settlements.'],
      ['bills', 'Supplier Bills', 'finance.payables.view', 'Finance & Reports', 'Bills from suppliers and their payment.'],
      ['collections', 'Collections', 'sales.collections.confirm', 'Finance & Reports', 'Cash and payments collected in the field, waiting for confirmation.'],
    ]],
    ['Insights', [
      ['insights', 'Smart Insights', 'reports.export', 'Overview', 'Sales forecast, stock-out and reorder advice, customer risk, alerts and suggestions.'],
      ['assistant', 'AI Assistant', 'reports.export', 'Overview', 'Ask questions about sales, stock and customers in plain words (off until a provider key is added).'],
      ['overview', 'System Health', 'core.monitoring.view', 'Overview', 'Background jobs, monitoring events and the database.'],
    ]],
    ['Team & control', [
      ['staff', 'Business Staff & Roles', 'core.staff.view', 'Administration', 'Business staff, their roles, and adding salesmen and delivery people.'],
      ['approvals', 'Approvals', 'core.approvals.view', 'Administration', 'Requests waiting for a second person to approve.'],
      ['decisions', 'Business Decisions', 'core.settings.view', 'Administration', 'The rules the business has decided (limits, stock modes, OTP and more).'],
      ['notifications', 'Notifications', 'notifications.view', 'Administration', 'Messages to customers, retailers and staff, with consent.'],
      ['offline', 'Offline Sync', 'offline.view', 'Administration', 'Work saved by the field app without signal, and how it was settled.'],
      ['audit', 'Audit Log', 'core.audit.view', 'Administration', 'Who did what and when; tamper-checked.'],
      ['branding', 'Logos & Bills', 'core.settings.view', 'Administration', 'Your logo library, and which logo prints on bills.'],
      ['account', 'My Password & 2FA', 'core.self.view', 'Administration', 'Your password and two-step sign-in.'],
    ]],
  ];

  function render(main) {
    main.appendChild(el('h1', { text: 'ERP Home' }));
    main.appendChild(el('section', { class: 'panel' }, [
      el('h2', { text: 'What is ERP?' }),
      el('p', { text: 'ERP (Enterprise Resource Planning) is the business side of Sake of Health: everything behind the online shop. Stock in the warehouses, buying from suppliers, manufacturing, selling to retailers and distributors, field salesmen, deliveries, bills and payments, staff, roles and approvals.' }),
      el('p', { class: 'note', text: 'In this admin panel the ERP pages sit in the business areas of the menu (Sales & Orders, Inventory, Procurement & Suppliers, Finance & Reports, Administration…). This page lists them all in one place. Salesmen, delivery staff and event staff work in the Field app on their phone: sakeofhealth.com/sales-app/.' }),
    ]));
    var total = 0, open = 0;
    AREAS.forEach(function (area) {
      var items = area[1].filter(function (m) { total++; return has(m[2]); });
      open += items.length;
      if (!items.length) return;
      main.appendChild(el('section', { class: 'panel' }, [el('h2', { text: area[0] }), el('div', { class: 'grid' }, items.map(function (m) {
        return el('div', { class: 'panel' }, [
          el('strong', { text: m[1] }),
          el('p', { class: 'note', text: m[4] }),
          el('p', { class: 'note', text: 'Menu: ' + m[3] + ' → ' + m[1] }),
          el('button', { class: 'btn primary', type: 'button', text: 'Open', 'aria-label': 'Open ' + m[1], on: { click: function () { E.show(m[0]); } } }),
        ]);
      }))]));
    });
    main.insertBefore(el('p', { class: 'note', text: 'Your role can open ' + open + ' of the ' + total + ' ERP modules.' }), main.children[2] || null);
  }

  window.ERP_VIEWS.push({ id: 'erphome', label: 'ERP Home', perm: 'core.self.view', render: render });
})();
