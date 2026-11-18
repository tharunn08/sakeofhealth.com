# Printing delivery labels and bills

Every order — customer (B2C) and business (B2B) — can be printed as:

* a **delivery label** to stick on the parcel, and
* a **bill / tax invoice** to go inside it.

## Where the buttons are

| Who | Where |
|---|---|
| Admin, customer orders | Admin → Orders → open an order → **Print** (label or bill). **Print labels** at the top prints every open order on the page. Also on each card in Admin → Deliveries. |
| Admin, business orders | Admin → B2B Orders → open an order → **Delivery label** / **Tax invoice**. Tick several orders and use **Print labels** for a batch. |
| Distributor | Business portal → Retailer orders → open an order, or tick several → **Print labels**. |
| Retailer / distributor (as buyer) | Business portal → Orders or Invoices → **Order summary / Invoice**. |

## What is on the label

* Receiver name, full address and landmark
* **Pincode and phone number in large type**
* Order number as a **barcode** (Code 128 — scan it into the admin search)
* A **QR code** that opens Google Maps directions to the address (uses the
  customer's map pin when there is one)
* Item list with quantities (can be switched off)
* **COLLECT ₹…** box when money is due on delivery, or PAID
* Delivered / name / signature line
* Sender name and address

## Paper sizes

| Document | Options |
|---|---|
| Label | **4 × 6 inch (100 × 150 mm)** thermal label — one per page — or **A4, four labels per sheet** |
| Bill | **A4** or **A5** |

In the browser's print dialog set **Margins: None** and **Scale: 100 %**, and
switch off "Headers and footers". For a thermal printer choose the 4 × 6 /
100 × 150 mm paper size in the dialog.

## Sender address

* Customer orders: on the print page, **Sender details** (admin or manager).
  Saved once, used for every label and bill.
* Business orders: B2B Settings → Company & invoices. Orders supplied by a
  distributor print the distributor's own name and address.

Nothing is sent to an outside service to make the barcode or QR code; both are
drawn in the browser.
