// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuthCaptureEscrow} from "commerce-payments/AuthCaptureEscrow.sol";

/// @title RecourseOperator
/// @notice The `"custom"` operator of x402's `auth-capture` scheme, with Internet Court as its arbitrator.
///
///         x402 `auth-capture` holds a buyer's payment in Coinbase's AuthCaptureEscrow and lets the payment's operator
///         capture it to the seller or void it back to the buyer. The scheme's EVM binding allows a custom operator to
///         add "arbitration" without changing the escrow, the facilitator or the scheme. This contract is that operator:
///
///         - Sellers list a service with a price and a promise: plain words saying what a paid call returns.
///         - `authorize` is permissionless, as the spec requires of a custom operator, and forwards to the escrow after
///           checking that the payment pays one listing's seller its exact price, with no fee, and leaves time for the
///           seller to deliver, the buyer to dispute and the court to rule before the escrow's capture deadline.
///         - The buyer's request is bound into the payment's own identity: the low 224 bits of `PaymentInfo.salt` are a
///           commitment to it, and the high 32 bits name the listing. The buyer's token signature covers the salt.
///         - The seller records its response with `deliver`. Only the seller can, once, so the record is its own.
///         - With no dispute inside the listing's window, anybody captures the payment to the seller.
///         - The buyer may dispute inside the window. Then only the court decides: DELIVERED captures, NOT_DELIVERED
///           voids. The court is an Intelligent Contract on GenLayer that calls `rule` itself when its verdict is final.
///         - A seller may refund at any time. A payment never delivered can be voided by anybody after its deadline. And
///           the escrow's own `reclaim` returns the hold to the buyer after the capture deadline, whatever happens here.
///
///         Money never sits in this contract: it is in the escrow, and the escrow only ever pays the listed seller or
///         returns to the payer.
contract RecourseOperator {
    enum Status { None, Held, Delivered, Disputed, Captured, Voided }

    struct Listing {
        address seller;
        address token;
        uint120 price;
        uint32 deliverWithin;
        uint32 window;
        bool active;
        string title;
        string offer;
    }

    struct Record {
        Status status;
        uint32 listingId;
        uint48 heldAt;
        uint48 deliveredAt;
        uint48 disputedAt;
        bool ruled;
        bool delivered;
        bytes32 reason;
        string request;
        string response;
    }

    uint256 public constant MAX_TITLE = 80;
    uint256 public constant MAX_OFFER = 1000;
    uint256 public constant MAX_REQUEST = 1000;
    uint256 public constant MAX_RESPONSE = 4000;
    uint48 public constant COURT_TIME = 1 hours;
    uint32 public constant MIN_WINDOW = 60;
    uint32 public constant MAX_WINDOW = 7 days;

    AuthCaptureEscrow public immutable escrow;
    address public immutable deployer;
    address public court;

    Listing[] internal listings;
    mapping(bytes32 => AuthCaptureEscrow.PaymentInfo) internal payments;
    mapping(bytes32 => Record) internal records;
    bytes32[] public paymentHashes;

    event CourtSet(address court);
    event Listed(uint32 indexed listingId, address indexed seller, uint120 price, string title);
    event ListingClosed(uint32 indexed listingId);
    event Authorized(bytes32 indexed paymentHash, uint32 indexed listingId, address indexed payer, uint120 amount);
    event Delivered(bytes32 indexed paymentHash);
    event Disputed(bytes32 indexed paymentHash);
    event Captured(bytes32 indexed paymentHash, address by);
    event Voided(bytes32 indexed paymentHash, string why);
    event Ruled(bytes32 indexed paymentHash, bool delivered, bytes32 reason);

    constructor(AuthCaptureEscrow escrow_) {
        escrow = escrow_;
        deployer = msg.sender;
    }

    /// One time wiring: the operator is deployed before the court that rules on it.
    function setCourt(address court_) external {
        require(msg.sender == deployer, "Recourse:only-deployer");
        require(court == address(0) && court_ != address(0), "Recourse:court-set");
        court = court_;
        emit CourtSet(court_);
    }

    // ------------------------------------------------------------------ listings

    function list(address token, uint120 price, uint32 deliverWithin, uint32 window, string calldata title, string calldata offer)
        external
        returns (uint32 listingId)
    {
        require(price > 0, "Recourse:price");
        require(deliverWithin >= 30 && deliverWithin <= 1 days, "Recourse:deliver-within");
        require(window >= MIN_WINDOW && window <= MAX_WINDOW, "Recourse:window");
        require(bytes(title).length > 0 && bytes(title).length <= MAX_TITLE, "Recourse:title");
        require(bytes(offer).length > 0 && bytes(offer).length <= MAX_OFFER, "Recourse:offer");
        listingId = uint32(listings.length);
        listings.push(Listing(msg.sender, token, price, deliverWithin, window, true, title, offer));
        emit Listed(listingId, msg.sender, price, title);
    }

    /// A seller can stop taking new payments; payments already held keep their terms.
    function close(uint32 listingId) external {
        require(listings[listingId].seller == msg.sender, "Recourse:only-seller");
        listings[listingId].active = false;
        emit ListingClosed(listingId);
    }

    // ------------------------------------------------------------------ the x402 collect entry point

    /// The request commitment a buyer puts in the low 224 bits of the payment's salt.
    function requestCommitment(string memory request, bytes32 nonce) public pure returns (uint224) {
        return uint224(uint256(keccak256(abi.encode(keccak256(bytes(request)), nonce))));
    }

    /// The salt a buyer signs for a listing and a request.
    function saltFor(uint32 listingId, string calldata request, bytes32 nonce) external pure returns (uint256) {
        return (uint256(listingId) << 224) | uint256(requestCommitment(request, nonce));
    }

    /// Permissionless, as x402's custom operator type requires: anybody, the facilitator included, may relay a buyer's
    /// signed authorization. It holds the payment in the escrow only if it pays one listing exactly.
    function authorize(AuthCaptureEscrow.PaymentInfo calldata p, uint256 amount, address tokenCollector, bytes calldata collectorData)
        external
    {
        require(p.operator == address(this), "Recourse:operator");
        uint32 listingId = uint32(p.salt >> 224);
        require(listingId < listings.length, "Recourse:no-listing");
        Listing storage l = listings[listingId];
        require(l.active, "Recourse:listing-closed");
        require(p.receiver == l.seller && p.token == l.token, "Recourse:not-this-listing");
        require(amount == l.price && p.maxAmount == l.price, "Recourse:price-mismatch");
        require(p.minFeeBps == 0 && p.maxFeeBps == 0 && p.feeReceiver == address(0), "Recourse:no-fees");
        require(p.authorizationExpiry >= block.timestamp + l.deliverWithin + l.window + COURT_TIME, "Recourse:capture-deadline-too-soon");

        bytes32 h = escrow.getHash(p);
        escrow.authorize(p, amount, tokenCollector, collectorData);
        payments[h] = p;
        Record storage r = records[h];
        r.status = Status.Held;
        r.listingId = listingId;
        r.heldAt = uint48(block.timestamp);
        paymentHashes.push(h);
        emit Authorized(h, listingId, p.payer, uint120(amount));
    }

    // ------------------------------------------------------------------ the lifecycle

    /// The seller records the request it served and what it returned. Only the seller, once, before its deadline.
    function deliver(bytes32 h, string calldata request, bytes32 nonce, string calldata response) external {
        Record storage r = records[h];
        AuthCaptureEscrow.PaymentInfo storage p = payments[h];
        require(r.status == Status.Held, "Recourse:not-held");
        require(msg.sender == p.receiver, "Recourse:only-seller");
        require(block.timestamp <= r.heldAt + listings[r.listingId].deliverWithin, "Recourse:delivery-late");
        require(bytes(request).length <= MAX_REQUEST, "Recourse:request-length");
        require(bytes(response).length > 0 && bytes(response).length <= MAX_RESPONSE, "Recourse:response-length");
        require(uint224(p.salt) == requestCommitment(request, nonce), "Recourse:request-mismatch");
        r.request = request;
        r.response = response;
        r.deliveredAt = uint48(block.timestamp);
        r.status = Status.Delivered;
        emit Delivered(h);
    }

    /// With no dispute inside the window, anybody pays the seller.
    function capture(bytes32 h) external {
        Record storage r = records[h];
        require(r.status == Status.Delivered, "Recourse:not-delivered");
        require(block.timestamp >= r.deliveredAt + listings[r.listingId].window, "Recourse:window-open");
        r.status = Status.Captured;
        AuthCaptureEscrow.PaymentInfo memory p = payments[h];
        escrow.capture(p, p.maxAmount, 0, address(0));
        emit Captured(h, msg.sender);
    }

    /// The buyer disputes a delivery, inside the window. From here only the court decides.
    function dispute(bytes32 h) external {
        Record storage r = records[h];
        require(r.status == Status.Delivered, "Recourse:not-delivered");
        require(msg.sender == payments[h].payer, "Recourse:only-payer");
        require(block.timestamp < r.deliveredAt + listings[r.listingId].window, "Recourse:window-closed");
        r.status = Status.Disputed;
        r.disputedAt = uint48(block.timestamp);
        emit Disputed(h);
    }

    /// Internet Court's ruling on a disputed payment, sent by the court itself when its verdict is final.
    function rule(bytes32 h, bool delivered, bytes32 reason) external {
        require(msg.sender == court, "Recourse:only-court");
        Record storage r = records[h];
        require(r.status == Status.Disputed, "Recourse:not-disputed");
        r.ruled = true;
        r.delivered = delivered;
        r.reason = reason;
        AuthCaptureEscrow.PaymentInfo memory p = payments[h];
        if (delivered) {
            r.status = Status.Captured;
            escrow.capture(p, p.maxAmount, 0, address(0));
        } else {
            r.status = Status.Voided;
            escrow.void(p);
        }
        emit Ruled(h, delivered, reason);
    }

    /// A seller can always give the money back before it is captured.
    function refund(bytes32 h) external {
        Record storage r = records[h];
        require(msg.sender == payments[h].receiver, "Recourse:only-seller");
        require(r.status == Status.Held || r.status == Status.Delivered || r.status == Status.Disputed, "Recourse:not-open");
        r.status = Status.Voided;
        escrow.void(payments[h]);
        emit Voided(h, "refunded by the seller");
    }

    /// A payment the seller never delivered goes back to the buyer, without anybody's judgment.
    function voidUndelivered(bytes32 h) external {
        Record storage r = records[h];
        require(r.status == Status.Held, "Recourse:not-held");
        require(block.timestamp > r.heldAt + listings[r.listingId].deliverWithin, "Recourse:delivery-not-late");
        r.status = Status.Voided;
        escrow.void(payments[h]);
        emit Voided(h, "not delivered in time");
    }

    // ------------------------------------------------------------------ reads, flat for any caller

    function listingCount() external view returns (uint256) {
        return listings.length;
    }

    function listingFacts(uint32 id)
        external
        view
        returns (address seller, address token, uint120 price, uint32 deliverWithin, uint32 window, bool active)
    {
        Listing storage l = listings[id];
        return (l.seller, l.token, l.price, l.deliverWithin, l.window, l.active);
    }

    function listingTitle(uint256 id) external view returns (string memory) {
        return listings[id].title;
    }

    function listingOffer(uint32 id) external view returns (string memory) {
        return listings[id].offer;
    }

    function paymentCount() external view returns (uint256) {
        return paymentHashes.length;
    }

    function facts(bytes32 h)
        external
        view
        returns (uint8 status, uint32 listingId, address payer, address seller, uint120 amount, uint48 deliveredAt, uint48 disputedAt, uint48 captureDeadline)
    {
        Record storage r = records[h];
        AuthCaptureEscrow.PaymentInfo storage p = payments[h];
        return (uint8(r.status), r.listingId, p.payer, p.receiver, p.maxAmount, r.deliveredAt, r.disputedAt, p.authorizationExpiry);
    }

    function ruling(bytes32 h) external view returns (bool ruled, bool delivered, bytes32 reason) {
        Record storage r = records[h];
        return (r.ruled, r.delivered, r.reason);
    }

    function offerOf(bytes32 h) external view returns (string memory) {
        return listings[records[h].listingId].offer;
    }

    function requestOf(bytes32 h) external view returns (string memory) {
        return records[h].request;
    }

    function responseOf(bytes32 h) external view returns (string memory) {
        return records[h].response;
    }

    function paymentInfo(bytes32 h) external view returns (AuthCaptureEscrow.PaymentInfo memory) {
        return payments[h];
    }
}
