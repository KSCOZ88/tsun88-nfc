'use strict';
// A payment receipt can be complete for the customer without a merchant mail.
// Never pretend a merchant message was sent just because the customer message succeeded.
function deliveryOutcome(stage,previous={},result={}){
 const customerSent=!!(previous.customer_sent||result.customerSent);
 const merchantSent=!!(previous.merchant_sent||result.merchantSent);
 const complete=customerSent&&(stage!=='order_completed'||merchantSent);
 return {customerSent,merchantSent,complete};
}
module.exports={deliveryOutcome};
