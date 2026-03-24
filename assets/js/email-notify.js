import { currency, formatDateTime } from './utils.js';

function isConfigured(settings = {}) {
  return Boolean(
    settings?.emailNotificationsEnabled
    && settings?.notificationEmail
    && settings?.emailjsPublicKey
    && settings?.emailjsServiceId
    && settings?.emailjsTemplateId
  );
}

function buildItemLines(items = []) {
  return items.map((item) => {
    const accessoryText = Array.isArray(item.accessories) && item.accessories.length
      ? ` [Accessories: ${item.accessories.map((acc) => `${acc.name} ($${Number(acc.price || 0).toFixed(2)} ea)`).join(', ')}]`
      : '';
    return `- ${item.name} x${Number(item.quantity || 0)} — ${currency(Number(item.subtotal || 0))}${accessoryText}`;
  }).join('\n');
}

function buildContactLines(contactMethods = {}) {
  return Object.entries(contactMethods)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

function buildTemplateParams(settings, order) {
  const itemsText = buildItemLines(order.items || []);
  const contactsText = buildContactLines(order.contactMethods || {});
  const deliveryAddress = order.fulfillmentType === 'Delivery' ? (order.address || order.addressSnapshot || '') : '';
  const deliveryBits = [
    order.fulfillmentType,
    order.fulfillmentType === 'Delivery' && deliveryAddress ? `Address: ${deliveryAddress}` : '',
    order.fulfillmentType === 'Delivery' && Number.isFinite(Number(order.deliveryMiles)) ? `Miles: ${Number(order.deliveryMiles).toFixed(1)}` : '',
    order.fulfillmentType === 'Delivery' ? `Delivery fee: ${currency(Number(order.deliveryFee || 0))}` : 'Delivery fee: Pickup selected',
    order.deliveryNeedsReview ? 'Delivery estimate marked for review: Yes' : ''
  ].filter(Boolean).join('\n');

  return {
    to_email: settings.notificationEmail,
    reply_to: settings.notificationEmail,
    from_name: settings.notificationFromName || settings.businessName || 'Rent Some Orders',
    business_name: settings.businessName || 'Rent Some Orders',
    inquiry_id: order.id,
    customer_name: `${order.firstName || ''} ${order.lastName || ''}`.trim(),
    exchange_datetime: formatDateTime(order.exchangeDate, order.exchangeTime),
    return_datetime: formatDateTime(order.returnDate, order.returnTime),
    fulfillment_type: order.fulfillmentType || '',
    delivery_address: deliveryAddress,
    delivery_miles: Number(order.deliveryMiles || 0).toFixed(1),
    delivery_fee: currency(Number(order.deliveryFee || 0)),
    subtotal: currency(Number(order.subtotal || 0)),
    total: currency(Number(order.total || 0)),
    items_text: itemsText,
    contacts_text: contactsText,
    delivery_text: deliveryBits,
    message: [
      `New inquiry from ${(`${order.firstName || ''} ${order.lastName || ''}`).trim() || 'Customer'}`,
      '',
      `Exchange: ${formatDateTime(order.exchangeDate, order.exchangeTime)}`,
      `Return: ${formatDateTime(order.returnDate, order.returnTime)}`,
      '',
      deliveryBits,
      '',
      'Contact methods:',
      contactsText || 'None provided',
      '',
      'Items:',
      itemsText || 'No items selected',
      '',
      `Subtotal: ${currency(Number(order.subtotal || 0))}`,
      `Total: ${currency(Number(order.total || 0))}`
    ].join('\n')
  };
}

export async function sendInquiryNotification(settings = {}, order = {}) {
  if (!isConfigured(settings)) {
    return { sent: false, status: 'skipped', reason: 'Email notifications are not fully configured.' };
  }

  const payload = {
    service_id: settings.emailjsServiceId,
    template_id: settings.emailjsTemplateId,
    user_id: settings.emailjsPublicKey,
    template_params: buildTemplateParams(settings, order)
  };

  const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(errorText || `Notification request failed (${response.status}).`);
  }

  return { sent: true, status: 'sent' };
}
